import { Controller, Get, Param, Post } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { SlotService, type Slot } from "./slot.service";

/** HTTP-контроллер слотов доставки. */
@Controller("slots")
export class SlotsController {
  constructor(private readonly slots: SlotService) {}

  /** Слот по идентификатору. */
  @Get(":id")
  @ApiOperation({ operationId: "getSlot", summary: "Слот по идентификатору" })
  get(@Param("id") id: string): Promise<Slot> {
    return this.slots.find(id);
  }

  @Post(":id/reserve")
  @ApiOperation({ operationId: "reserveSlot", summary: "Зарезервировать слот" })
  async reserve(@Param("id") id: string): Promise<void> {
    await this.slots.reserve(id);
  }
}
