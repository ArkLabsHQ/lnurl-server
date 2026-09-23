// Package dynamo keeps the authority's records and the operator's approvals in one
// DynamoDB table. Every transition is a single conditional write and every read is
// strongly consistent: an eventually consistent read is never a freshness source.
package dynamo

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

const stateKey = "STATE"

var pcrHex = regexp.MustCompile(`^[0-9a-f]{96}$`)

type API interface {
	GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, in *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

type Store struct {
	api   API
	table string
}

func New(api API, table string) *Store { return &Store{api: api, table: table} }

func (s *Store) key(deployment, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": str("DEPLOYMENT#" + deployment), "sk": str(sk)}
}

func (s *Store) Get(ctx context.Context, deployment string) (*state.Record, error) {
	out, err := s.api.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.table), Key: s.key(deployment, stateKey), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if len(out.Item) == 0 {
		return nil, state.ErrNotFound
	}
	return decodeRecord(out.Item)
}

// Create is the operator's bootstrap; no enclave-reachable path calls it.
func (s *Store) Create(ctx context.Context, r state.Record) error {
	item := encodeRecord(r)
	for k, v := range s.key(r.Deployment, stateKey) {
		item[k] = v
	}
	_, err := s.api.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.table), Item: item, ConditionExpression: aws.String("attribute_not_exists(pk)"),
	})
	if isConditionFailure(err) {
		return state.ErrExists
	}
	return err
}

func (s *Store) PutChallenge(ctx context.Context, deployment string, c state.Challenge, nowMs uint64) error {
	_, err := s.api.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.table), Key: s.key(deployment, stateKey),
		UpdateExpression:          aws.String("SET #pc = :pc, #rv = #rv + :one, #upd = :now"),
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeNames:  map[string]string{"#pc": "pendingChallenge", "#rv": "recordVersion", "#upd": "updatedAtMs"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":pc": encodeChallenge(c), ":one": num(1), ":now": num(nowMs)},
	})
	if isConditionFailure(err) {
		return state.ErrNotFound
	}
	return err
}

func (s *Store) Activate(ctx context.Context, a state.Activation) (*state.Record, error) {
	values := map[string]types.AttributeValue{
		":expected": num(a.ExpectedEpoch), ":next": num(a.ExpectedEpoch + 1), ":challenge": str(a.ChallengeID),
		":now": num(a.NowMs), ":rpv": num(uint64(a.ReleasePolicyVersion)), ":writer": encodeWriter(a.Writer), ":one": num(1),
	}
	names := map[string]string{
		"#epoch": "epoch", "#pc": "pendingChallenge", "#id": "id", "#exp": "expiresAtMs", "#rpv": "releasePolicyVersion",
		"#cp": "checkpoint", "#seq": "sequence", "#w": "writer", "#rv": "recordVersion", "#upd": "updatedAtMs",
	}
	condition := "attribute_exists(pk) AND #epoch = :expected AND #pc.#id = :challenge AND #pc.#exp > :now AND #rpv <= :rpv AND "
	// DynamoDB refuses a declared name or value an expression does not use.
	if a.Restored == nil {
		condition += "attribute_not_exists(#cp) AND #seq = :zero"
		values[":zero"] = num(0)
	} else {
		condition += "#cp.#ctd = :restored AND #seq = :restoredSequence"
		names["#ctd"] = "ciphertextDigest"
		values[":restored"], values[":restoredSequence"] = str(a.Restored.CiphertextDigest), num(a.Restored.Sequence)
	}
	return s.transition(ctx, a.Deployment, &dynamodb.UpdateItemInput{
		UpdateExpression:          aws.String("SET #epoch = :next, #w = :writer, #rpv = :rpv, #rv = #rv + :one, #upd = :now REMOVE #pc"),
		ConditionExpression:       aws.String(condition),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
	})
}

func (s *Store) Commit(ctx context.Context, c state.CommitUpdate) (*state.Record, error) {
	values := map[string]types.AttributeValue{
		":epoch": num(c.Epoch), ":wk": bin(c.WriterPublicKey), ":expected": num(c.ExpectedSequence), ":op": str(c.OperationID),
		":head": encodeHead(c.Head), ":next": num(c.Head.Sequence), ":one": num(1), ":now": num(c.NowMs),
	}
	names := map[string]string{
		"#epoch": "epoch", "#w": "writer", "#wk": "publicKey", "#seq": "sequence", "#op": "currentOperationId",
		"#cp": "checkpoint", "#rv": "recordVersion", "#upd": "updatedAtMs",
	}
	condition := "#epoch = :epoch AND #w.#wk = :wk AND #seq = :expected AND (attribute_not_exists(#op) OR #op <> :op) AND "
	if c.PriorDigest == nil {
		condition += "attribute_not_exists(#cp)"
	} else {
		condition += "#cp.#ctd = :prior"
		names["#ctd"] = "ciphertextDigest"
		values[":prior"] = str(*c.PriorDigest)
	}
	return s.transition(ctx, c.Deployment, &dynamodb.UpdateItemInput{
		UpdateExpression:          aws.String("SET #seq = :next, #cp = :head, #op = :op, #rv = #rv + :one, #upd = :now"),
		ConditionExpression:       aws.String(condition),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
	})
}

// transition runs a conditional update. On failure DynamoDB returns the item as it
// stood, so the refusal costs no second read.
func (s *Store) transition(ctx context.Context, deployment string, in *dynamodb.UpdateItemInput) (*state.Record, error) {
	in.TableName, in.Key = aws.String(s.table), s.key(deployment, stateKey)
	in.ReturnValues = types.ReturnValueAllNew
	in.ReturnValuesOnConditionCheckFailure = types.ReturnValuesOnConditionCheckFailureAllOld
	out, err := s.api.UpdateItem(ctx, in)
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		if len(failed.Item) == 0 {
			return nil, state.ErrNotFound
		}
		current, err := decodeRecord(failed.Item)
		if err != nil {
			return nil, err
		}
		return nil, &state.ConditionFailed{Current: current}
	}
	if err != nil {
		return nil, err
	}
	return decodeRecord(out.Attributes)
}

// Approved implements state.Approvals from the operator's approval records.
func (s *Store) Approved(ctx context.Context, deployment string, pcrs [3]string) (uint32, bool, error) {
	out, err := s.api.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.table), Key: s.key(deployment, approvalKey(pcrs)), ConsistentRead: aws.Bool(true),
	})
	if err != nil || len(out.Item) == 0 {
		return 0, false, err
	}
	var failure error
	r := reader{m: out.Item, err: &failure}
	policy := r.u32("releasePolicyVersion")
	return policy, failure == nil, failure
}

// Approve records that these measurements may write for the deployment under a
// release policy. It is the operator's act, with the operator's own credentials.
func (s *Store) Approve(ctx context.Context, deployment string, pcrs [3]string, policy uint32) error {
	for i, p := range pcrs {
		if !pcrHex.MatchString(p) {
			return fmt.Errorf("dynamo: PCR%d must be 96 lowercase hex characters", i)
		}
	}
	item := s.key(deployment, approvalKey(pcrs))
	item["releasePolicyVersion"] = num(uint64(policy))
	_, err := s.api.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.table), Item: item})
	return err
}

func approvalKey(pcrs [3]string) string { return "APPROVAL#" + pcrs[0] + "#" + pcrs[1] + "#" + pcrs[2] }

func isConditionFailure(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

func str(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
func num(v uint64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatUint(v, 10)}
}
func bin(v []byte) types.AttributeValue { return &types.AttributeValueMemberB{Value: v} }
func mapOf(m map[string]types.AttributeValue) types.AttributeValue {
	return &types.AttributeValueMemberM{Value: m}
}

func encodeRecord(r state.Record) map[string]types.AttributeValue {
	item := map[string]types.AttributeValue{
		"deployment": str(r.Deployment), "prefix": str(r.Prefix), "epoch": num(r.Epoch),
		"releasePolicyVersion": num(uint64(r.ReleasePolicyVersion)), "sequence": num(r.Sequence),
		"recordVersion": num(r.RecordVersion), "updatedAtMs": num(r.UpdatedAtMs),
	}
	if r.Writer != nil {
		item["writer"] = encodeWriter(*r.Writer)
	}
	if r.Checkpoint != nil {
		item["checkpoint"] = encodeHead(*r.Checkpoint)
	}
	if r.CurrentOperationID != "" {
		item["currentOperationId"] = str(r.CurrentOperationID)
	}
	if r.PendingChallenge != nil {
		item["pendingChallenge"] = encodeChallenge(*r.PendingChallenge)
	}
	return item
}

func encodeWriter(w state.Writer) types.AttributeValue {
	return mapOf(map[string]types.AttributeValue{
		"publicKey": bin(w.PublicKey), "pcr0": str(w.PCRs[0]), "pcr1": str(w.PCRs[1]), "pcr2": str(w.PCRs[2]),
		"activatedAtMs": num(w.ActivatedAtMs), "quoteSha256": str(w.QuoteSHA256),
	})
}

func encodeHead(h wire.Head) types.AttributeValue {
	m := map[string]types.AttributeValue{
		"schema": str(h.Schema), "prefix": str(h.Prefix), "schemaVersion": num(uint64(h.SchemaVersion)),
		"sealEpoch": num(h.SealEpoch), "sequence": num(h.Sequence), "digest": str(h.Digest), "size": num(h.Size),
		"ciphertextDigest": str(h.CiphertextDigest), "key": str(h.Key),
	}
	if h.PreviousDigest != nil {
		m["previousDigest"] = str(*h.PreviousDigest)
	}
	return mapOf(m)
}

func encodeChallenge(c state.Challenge) types.AttributeValue {
	return mapOf(map[string]types.AttributeValue{"id": str(c.ID), "nonce": bin(c.Nonce), "expiresAtMs": num(c.ExpiresAtMs)})
}

func decodeRecord(item map[string]types.AttributeValue) (*state.Record, error) {
	var failure error
	r := reader{m: item, err: &failure}
	rec := &state.Record{
		Deployment: r.str("deployment"), Prefix: r.str("prefix"), Epoch: r.u64("epoch"),
		ReleasePolicyVersion: r.u32("releasePolicyVersion"), Sequence: r.u64("sequence"),
		RecordVersion: r.u64("recordVersion"), UpdatedAtMs: r.u64("updatedAtMs"),
	}
	if w, ok := r.sub("writer"); ok {
		rec.Writer = &state.Writer{
			PublicKey: w.bin("publicKey"), PCRs: [3]string{w.str("pcr0"), w.str("pcr1"), w.str("pcr2")},
			ActivatedAtMs: w.u64("activatedAtMs"), QuoteSHA256: w.str("quoteSha256"),
		}
	}
	if h, ok := r.sub("checkpoint"); ok {
		head := wire.Head{
			Schema: h.str("schema"), Prefix: h.str("prefix"), SchemaVersion: h.u32("schemaVersion"),
			SealEpoch: h.u64("sealEpoch"), Sequence: h.u64("sequence"), Digest: h.str("digest"), Size: h.u64("size"),
			CiphertextDigest: h.str("ciphertextDigest"), Key: h.str("key"),
		}
		if _, ok := h.m["previousDigest"]; ok {
			previous := h.str("previousDigest")
			head.PreviousDigest = &previous
		}
		rec.Checkpoint = &head
	}
	if _, ok := item["currentOperationId"]; ok {
		rec.CurrentOperationID = r.str("currentOperationId")
	}
	if c, ok := r.sub("pendingChallenge"); ok {
		rec.PendingChallenge = &state.Challenge{ID: c.str("id"), Nonce: c.bin("nonce"), ExpiresAtMs: c.u64("expiresAtMs")}
	}
	if failure != nil {
		return nil, failure
	}
	return rec, nil
}

// reader decodes attributes, keeping the first failure in err.
type reader struct {
	m   map[string]types.AttributeValue
	err *error
}

func (r reader) fail(name, want string) {
	if *r.err == nil {
		*r.err = fmt.Errorf("dynamo: attribute %q is missing or not %s", name, want)
	}
}

func (r reader) str(name string) string {
	if v, ok := r.m[name].(*types.AttributeValueMemberS); ok {
		return v.Value
	}
	r.fail(name, "a string")
	return ""
}

func (r reader) bin(name string) []byte {
	if v, ok := r.m[name].(*types.AttributeValueMemberB); ok {
		return v.Value
	}
	r.fail(name, "binary")
	return nil
}

func (r reader) u64(name string) uint64 {
	if v, ok := r.m[name].(*types.AttributeValueMemberN); ok {
		if n, err := strconv.ParseUint(v.Value, 10, 64); err == nil {
			return n
		}
	}
	r.fail(name, "an unsigned integer")
	return 0
}

func (r reader) u32(name string) uint32 {
	n := r.u64(name)
	if n > math.MaxUint32 {
		r.fail(name, "a 32-bit unsigned integer")
		return 0
	}
	return uint32(n)
}

func (r reader) sub(name string) (reader, bool) {
	v, ok := r.m[name]
	if !ok {
		return reader{}, false
	}
	if m, ok := v.(*types.AttributeValueMemberM); ok {
		return reader{m: m.Value, err: r.err}, true
	}
	r.fail(name, "a map")
	return reader{}, false
}
