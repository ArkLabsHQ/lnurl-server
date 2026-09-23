package quote

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/hf/nsm/request"
	"github.com/hf/nsm/response"
)

type fakeSession struct {
	res    response.Response
	err    error
	sent   []request.Request
	closed bool
}

func (f *fakeSession) Send(r request.Request) (response.Response, error) {
	f.sent = append(f.sent, r)
	return f.res, f.err
}

func (f *fakeSession) Close() error {
	f.closed = true
	return nil
}

func b64(n int, fill byte) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, n))
}

func counting(fake *fakeSession, opens *int) func() (Session, error) {
	return func() (Session, error) {
		*opens++
		return fake, nil
	}
}

var goodRequest = fmt.Sprintf(`{"nonce":%q,"userData":%q}`, b64(32, 1), b64(32, 2))

func TestQuotesExactlyTheRequestedNonceAndUserData(t *testing.T) {
	fake := &fakeSession{res: response.Response{Attestation: &response.Attestation{Document: []byte("cose-sign1")}}}
	opens := 0
	var out bytes.Buffer

	if err := Run(counting(fake, &opens), strings.NewReader(goodRequest), &out); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), base64.StdEncoding.EncodeToString([]byte("cose-sign1"))+"\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
	sent, ok := fake.sent[0].(*request.Attestation)
	if !ok || len(fake.sent) != 1 || opens != 1 {
		t.Fatalf("sent %#v over %d sessions, want one attestation request", fake.sent, opens)
	}
	if !bytes.Equal(sent.Nonce, bytes.Repeat([]byte{1}, 32)) || !bytes.Equal(sent.UserData, bytes.Repeat([]byte{2}, 32)) || sent.PublicKey != nil {
		t.Fatalf("request = %+v", sent)
	}
	if !fake.closed {
		t.Fatal("session left open")
	}
}

func TestRefusesABadRequestWithoutOpeningTheDevice(t *testing.T) {
	for name, in := range map[string]string{
		"malformed":      `{"nonce":`,
		"unknown field":  fmt.Sprintf(`{"nonce":%q,"userData":%q,"publicKey":"AA=="}`, b64(32, 1), b64(32, 2)),
		"missing nonce":  fmt.Sprintf(`{"userData":%q}`, b64(32, 2)),
		"empty userData": fmt.Sprintf(`{"nonce":%q,"userData":""}`, b64(32, 1)),
		"oversize nonce": fmt.Sprintf(`{"nonce":%q,"userData":%q}`, b64(MaxField+1, 1), b64(32, 2)),
		"trailing data":  goodRequest + ` {}`,
	} {
		t.Run(name, func(t *testing.T) {
			opens := 0
			var out bytes.Buffer
			if err := Run(counting(&fakeSession{}, &opens), strings.NewReader(in), &out); err == nil {
				t.Fatal("accepted")
			}
			if opens != 0 || out.Len() != 0 {
				t.Fatalf("opened the device %d times, wrote %q", opens, out.String())
			}
		})
	}
}

func TestReportsEveryNSMFailureAndWritesNothing(t *testing.T) {
	sessionFor := func(f *fakeSession) func() (Session, error) {
		return func() (Session, error) { return f, nil }
	}
	for name, open := range map[string]func() (Session, error){
		"no device":      func() (Session, error) { return nil, errors.New("open /dev/nsm: no such file or directory") },
		"send fails":     sessionFor(&fakeSession{err: errors.New("ioctl")}),
		"nsm refuses":    sessionFor(&fakeSession{res: response.Response{Error: response.ECInvalidArgument}}),
		"no document":    sessionFor(&fakeSession{res: response.Response{}}),
		"empty document": sessionFor(&fakeSession{res: response.Response{Attestation: &response.Attestation{}}}),
	} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			if err := Run(open, strings.NewReader(goodRequest), &out); err == nil {
				t.Fatal("reported success")
			}
			if out.Len() != 0 {
				t.Fatalf("wrote %q", out.String())
			}
		})
	}
}
