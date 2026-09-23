// Command lnurl-attest quotes one Nitro attestation document for the LNURL server: a JSON
// request on stdin, the base64 document on stdout, anything else a non-zero exit.
package main

import (
	"fmt"
	"os"

	"github.com/ArkLabsHQ/lnurl-server/attestor/internal/quote"
	"github.com/hf/nsm"
)

func main() {
	open := func() (quote.Session, error) {
		s, err := nsm.OpenDefaultSession()
		if err != nil {
			return nil, err
		}
		return s, nil
	}
	if err := quote.Run(open, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "lnurl-attest:", err)
		os.Exit(1)
	}
}
