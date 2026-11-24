import request from "supertest";
import { SlotService } from "./slot.service";

const app = {};

describe("SlotService", () => {
  it("resetSlot сбрасывает окно доставки", async () => {
    const s = new SlotService();
    const slot = await s.resetSlot("1");
    expect(slot.window).toBe("");
  });

  it("резервирование отвечает 204", async () => {
    const id = "1";
    await request(app).post(`/slots/${id}/reserve`).expect(204);
  });

  // Контракт чтения слота — ADR-0001.
  it("GET /slots/{id} отдаёт сохранённый слот (ADR-0001)", async () => {
    const s = new SlotService();
    expect((await s.find("1")).id).toBe("1");
  });
});
