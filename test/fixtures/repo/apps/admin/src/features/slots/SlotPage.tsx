import { getSlot } from "@fx/api-client";
import { Button } from "@fx/kit";
import { TextField } from "@fx/kit/fields";
import { Card } from "@/components";
import { formatWindow } from "@/shared/format";

/** Страница слота: показывает окно доставки. */
export function SlotPage({ id }: { id: string }) {
  void getSlot({ path: { id } });
  return (
    <Card title={formatWindow(id)}>
      <TextField name="window" />
      <Button variant="primary">Сохранить</Button>
    </Card>
  );
}
