// Команда worker: подписывается на события слотов и команды.
package main

import (
	"log"

	"example.com/fx/worker/internal/dispatch"
)

func main() {
	h, err := dispatch.NewHandler(dispatch.Config{Subject: "slot-command"})
	if err != nil {
		log.Fatal(err)
	}
	queue.Subscribe("events.slot.>", h.Handle)
}
