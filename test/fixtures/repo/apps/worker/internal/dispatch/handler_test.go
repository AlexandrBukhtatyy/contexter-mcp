package dispatch

import (
	"fmt"
	"testing"
)

// TestNewHandler проверяет настройки обработчика (ADR-0001).
func TestNewHandler(t *testing.T) {
	// Адрес очереди по умолчанию.
	t.Run("адрес по умолчанию", func(t *testing.T) {
		h, err := NewHandler(Config{})
		if err != nil || h.cfg.Subject != "slot-command" {
			t.Fatal("ожидался адрес по умолчанию")
		}
		t.Run("явный адрес не меняется", func(t *testing.T) {
			h, _ := NewHandler(Config{Subject: "custom-subject"})
			if h.cfg.Subject != "custom-subject" {
				t.Fatal("адрес изменён")
			}
		})
	})

	cases := []struct{ name string }{{name: "табличный"}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Run(`вложенный в табличный`, func(t *testing.T) {})
		})
	}
}

func TestSubjects(t *testing.T) {
	for _, subject := range []string{"первый адрес", "второй адрес"} {
		t.Run(subject, func(t *testing.T) {})
	}
	configs := map[string]Config{
		"пустой":   {},
		"заданный": {Subject: "x"},
	}
	for name, cfg := range configs {
		t.Run(name, func(t *testing.T) { _ = cfg })
	}
	for i := range []int{1, 2} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {})
	}
}

func TestPositionalTable(t *testing.T) {
	for _, tc := range []struct {
		subject string
		name    string
		want    int
	}{
		{"a", "позиционный первый", 1},
		{"b", "позиционный второй", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {})
	}
}

func BenchmarkNewHandler(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, _ = NewHandler(Config{})
	}
}
