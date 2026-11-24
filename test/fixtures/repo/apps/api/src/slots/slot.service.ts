import { publish } from "../queue/publisher";

export interface Slot {
  id: string;
  window: string;
}

export const SLOT_RESERVED_SUBJECT = "events.slot.reserved";

/** Событие резервирования: поле slotIds — идентификаторы затронутых слотов. */
export interface SlotReservedEvent {
  slotIds: string[];
}

/**
 * Сервис слотов доставки: хранит выбранный слот и сбрасывает его при возврате из корзины.
 */
export class SlotService {
  private readonly store = new Map<string, Slot>();

  async find(id: string): Promise<Slot> {
    return this.store.get(id) ?? { id, window: "" };
  }

  /** Сбрасывает выбранный слот. */
  async resetSlot(id: string): Promise<Slot> {
    const slot = { id, window: "" };
    this.store.set(id, slot);
    return slot;
  }

  /** Идентификаторы всех известных слотов. */
  async slotIds(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async reserve(id: string): Promise<void> {
    await publish("events.slot.reserved", { slotId: id });
    await publish("slot-command", { slotId: id, action: "hold" });
  }

  /** Событие с вычисляемым адресом: связь по нему не строится. */
  async emit(kind: string, id: string): Promise<void> {
    await publish(`events.slot.${kind}`, { slotId: id });
  }
}
