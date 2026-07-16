import { createParser, type EventSourceMessage } from "eventsource-parser";

export interface ParsedSseEvent {
  id: string | undefined;
  event: string | undefined;
  data: unknown;
  rawData: Uint8Array;
}

export function createTxlineSseParser(
  onEvent: (event: ParsedSseEvent) => void,
): {
  feed(chunk: Uint8Array | string): void;
  reset(): void;
} {
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(message: EventSourceMessage) {
      const rawData = new TextEncoder().encode(message.data);
      const data = JSON.parse(message.data) as unknown;
      onEvent({ id: message.id, event: message.event, data, rawData });
    },
  });
  return {
    feed(chunk) {
      parser.feed(
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true }),
      );
    },
    reset() {
      parser.reset({ consume: true });
    },
  };
}
