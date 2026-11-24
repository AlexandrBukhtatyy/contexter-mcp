---
type: guide
status: active
owner: team-slots
covers:
  - apps/api/src/slots/**
---

# Слоты доставки

Руководство по слотам доставки: как выбранный слот хранится, сбрасывается и уходит в очередь.

## Хранение выбора слота

Выбранный слот лежит в сервисе слотов и сбрасывается при возврате из корзины. Сброс делает
`SlotService.resetSlot`, а прочитать текущий слот можно через `GET /slots/{id}`.

Код сервиса — [slot.service.ts](../../apps/api/src/slots/slot.service.ts), а пример вызова ниже:

```ts
const slot = await slots.resetSlot(id);
await publishSlotReserved(slot);
```

## Очередь и обработчик

Сервис публикует событие в канал `events.slot.reserved`; событие несёт поле `slotIds`.
Команды уходят в канал `slot-command`,
их забирает обработчик воркера `dispatch.NewHandler`; разбор кадров GSM — `gsm.ParseGSMFrame`.

Старое имя `dispatch.LegacyHandler` больше не существует, ссылка на него битая.
Битая ссылка на файл: [удалённый модуль](../../apps/api/src/slots/removed.ts).
Несуществующий эндпоинт: `POST /slots/legacy`. Health-проба `GET /livez` в контракт не входит. Через прокси admin слот читается как `GET /api/slots/{id}`.
Не пути репозитория: шаблон `docs/plans/stage-<N>-brief.md`, системный `/etc/hosts.yaml`,
импорт `./generated/sdk.gen`. Путь от исходника: `../../../contracts/openapi/api.yaml`.

## Короткая заметка

Слотов хватает всегда.

## Решения

Почему слот хранится на сервере, описано в ADR-0001. Ссылка на ADR-0009 — битая.
Список слотов сервис отдаёт вызовом `slotIds()`, а сброс делает `resetSlot`.
Каталог воркера: `apps/worker/internal/dispatch`.
