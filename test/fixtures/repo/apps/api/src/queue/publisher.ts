/** Публикует сообщение в очередь (в учебном репозитории — в память). */
export async function publish(subject: string, payload: unknown): Promise<void> {
  sent.push({ subject, payload });
}

export const sent: Array<{ subject: string; payload: unknown }> = [];

/** Адрес, которого нет в контракте: проверка должна это заметить. */
export async function publishAudit(): Promise<void> {
  await publish("audit.unknown", {});
}
