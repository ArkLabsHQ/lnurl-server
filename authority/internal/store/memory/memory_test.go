package memory

import (
	"testing"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state/storetest"
)

func TestTransitions(t *testing.T) {
	storetest.Run(t, func(*testing.T) state.Store { return New() })
}
