/**
 * Project Aegis - Dendrite-Lite Binary IPC Protocol
 * 
 * Implements:
 * - Issue #16: CORE-01 Low-Latency Binary IPC Protocol (Dendrite-Lite)
 */

export enum BinaryMessageType {
  MouseMove = 1,
  MouseClick = 2,
  ScreenshotFrame = 3,
  DOMBatchUpdate = 4,
  Heartbeat = 5
}

export interface DecodedBinaryMessage {
  type: BinaryMessageType;
  timestamp: number;
  payload: Buffer;
}

export class BinaryIPC {
  private static readonly MAGIC = 0xAE61501C; // 'AEGIS_IPC' magic header
  private static readonly HEADER_SIZE = 18; // 4 magic + 2 type + 4 length + 8 timestamp

  /**
   * Encodes a message type and raw payload into a high-performance binary buffer.
   */
  public static encode(type: BinaryMessageType, payload: Buffer): Buffer {
    const totalSize = BinaryIPC.HEADER_SIZE + payload.length;
    const buffer = Buffer.allocUnsafe(totalSize);

    buffer.writeUInt32BE(BinaryIPC.MAGIC, 0);
    buffer.writeUInt16BE(type, 4);
    buffer.writeUInt32BE(payload.length, 6);
    buffer.writeBigInt64BE(BigInt(Date.now()), 10);
    payload.copy(buffer, BinaryIPC.HEADER_SIZE);

    return buffer;
  }

  /**
   * Decodes a binary IPC buffer into structured data.
   */
  public static decode(buffer: Buffer): DecodedBinaryMessage {
    if (buffer.length < BinaryIPC.HEADER_SIZE) {
      throw new Error('Buffer smaller than minimum header size');
    }

    const magic = buffer.readUInt32BE(0);
    if (magic !== BinaryIPC.MAGIC) {
      throw new Error(`Invalid BinaryIPC magic header: 0x${magic.toString(16)}`);
    }

    const type = buffer.readUInt16BE(4) as BinaryMessageType;
    const length = buffer.readUInt32BE(6);
    const timestamp = Number(buffer.readBigInt64BE(10));

    const payload = buffer.subarray(BinaryIPC.HEADER_SIZE, BinaryIPC.HEADER_SIZE + length);

    return { type, timestamp, payload };
  }

  /**
   * Encodes mouse coordinate stream: (x: float64, y: float64).
   */
  public static encodeMouseMove(x: number, y: number): Buffer {
    const payload = Buffer.allocUnsafe(16);
    payload.writeDoubleBE(x, 0);
    payload.writeDoubleBE(y, 8);
    return BinaryIPC.encode(BinaryMessageType.MouseMove, payload);
  }

  /**
   * Decodes mouse coordinate stream.
   */
  public static decodeMouseMove(payload: Buffer): { x: number; y: number } {
    return {
      x: payload.readDoubleBE(0),
      y: payload.readDoubleBE(8)
    };
  }
}
