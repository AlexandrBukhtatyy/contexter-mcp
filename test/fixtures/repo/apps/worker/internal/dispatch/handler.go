package dispatch

import (
	"context"
	"fmt"

	gsm "example.com/fx/gsm"
)

// commandSubject — адрес очереди команд по слотам.
const commandSubject = "slot-command"

// Config — настройки обработчика.
type Config struct {
	Subject string `json:"subject,omitempty"`
}

// Handler обрабатывает команды по слотам доставки
// и отправляет кадры GSM-модулю.
type Handler struct {
	cfg Config
}

// Store — хранилище состояния слотов.
type Store interface {
	Load(ctx context.Context, id string) (string, error)
	Save(ctx context.Context, id, value string) error
}

// NewHandler создаёт обработчик команд.
func NewHandler(cfg Config) (*Handler, error) {
	if cfg.Subject == "" {
		cfg.Subject = commandSubject
	}
	return &Handler{cfg: cfg}, nil
}

// Handle разбирает команду и отвечает кадром GSM.
func (h *Handler) Handle(ctx context.Context, subject string, data []byte) error {
	frame, err := gsm.ParseGSMFrame(data)
	if err != nil {
		return fmt.Errorf("events.slot.%s: %w", subject, err)
	}
	return h.reply(ctx, frame)
}

func (h *Handler) reply(_ context.Context, frame gsm.Frame) error {
	_ = frame
	return nil
}
