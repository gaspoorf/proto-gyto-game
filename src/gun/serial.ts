// Lecture du port série ligne par ligne (Web Serial API : Chrome / Edge uniquement)

interface SerialPortLike {
  readable: ReadableStream<Uint8Array>;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export const serialSupported = (): boolean => 'serial' in navigator;

export async function openSerial({
  baudRate = 9600,
  onLine,
  onClose,
}: {
  baudRate?: number;
  onLine: (line: string) => void;
  onClose?: () => void;
}): Promise<SerialPortLike> {
  const serial = (navigator as unknown as { serial: SerialLike }).serial;
  const port = await serial.requestPort();
  await port.open({ baudRate });

  const reader = port.readable.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();

  (async () => {
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // les données arrivent par morceaux : on accumule jusqu'à avoir une ligne complète
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // le dernier morceau est incomplet, on le garde pour la suite

        for (const line of lines) {
          const clean = line.trim(); // enlève le \r de Serial.println
          if (clean) onLine(clean);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      reader.releaseLock();
      await port.close().catch(() => {});
      onClose?.();
    }
  })();

  return port;
}
