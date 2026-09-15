/** 单独输出最小证据，避免把测试标准输出或对象内容当作验收记录。 */
export default async function* evidenceReporter(events) {
  for await (const event of events) if (event.type === 'test:pass' || event.type === 'test:fail') {
    yield JSON.stringify({ event: event.type, file: event.data.file ?? null, name: event.data.name,
      skipped: Boolean(event.data.skip || event.data.todo) }) + '\n';
  }
}
