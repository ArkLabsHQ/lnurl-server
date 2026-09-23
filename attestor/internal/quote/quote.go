// Package quote turns one stdin request into one attestation document. It imports only
// hf/nsm's message types, never its device code, so it builds and tests off Linux.
package quote

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/hf/nsm/request"
	"github.com/hf/nsm/response"
)

// MaxField is NSM's own bound on nonce and user_data.
const MaxField = 512

// Session is the slice of an hf/nsm session a quote needs.
type Session interface {
	Send(request.Request) (response.Response, error)
	Close() error
}

type quoteRequest struct {
	Nonce    []byte `json:"nonce"`
	UserData []byte `json:"userData"`
}

// Run reads {"nonce","userData"} (base64) from in and writes the base64 document to out.
// A bad request is refused before the device is opened.
func Run(open func() (Session, error), in io.Reader, out io.Writer) error {
	var req quoteRequest
	dec := json.NewDecoder(io.LimitReader(in, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return fmt.Errorf("read request: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("read request: trailing data after the request")
	}
	for _, field := range []struct {
		name  string
		value []byte
	}{{"nonce", req.Nonce}, {"userData", req.UserData}} {
		if len(field.value) == 0 || len(field.value) > MaxField {
			return fmt.Errorf("%s must be 1 to %d bytes", field.name, MaxField)
		}
	}

	sess, err := open()
	if err != nil {
		return fmt.Errorf("open NSM session: %w", err)
	}
	defer func() { _ = sess.Close() }()
	res, err := sess.Send(&request.Attestation{Nonce: req.Nonce, UserData: req.UserData})
	if err != nil {
		return fmt.Errorf("attestation request: %w", err)
	}
	if res.Error != "" {
		return fmt.Errorf("attestation refused: %s", res.Error)
	}
	if res.Attestation == nil || len(res.Attestation.Document) == 0 {
		return errors.New("attestation response carries no document")
	}
	_, err = fmt.Fprintln(out, base64.StdEncoding.EncodeToString(res.Attestation.Document))
	return err
}
