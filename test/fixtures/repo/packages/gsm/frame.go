// Package gsm разбирает кадры GSM-модулей.
package gsm

import "errors"

// Frame — разобранный кадр.
type Frame struct {
	Code byte
}

// ParseGSMFrame разбирает кадр GSM-модуля.
func ParseGSMFrame(data []byte) (Frame, error) {
	if len(data) == 0 {
		return Frame{}, errors.New("пустой кадр")
	}
	return Frame{Code: data[0]}, nil
}
