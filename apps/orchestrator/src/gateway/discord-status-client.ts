/**
 * DiscordStatusClient (#30) — thin discord.js adapter for the Reporter sink.
 *
 * The {@link DiscordReporterSink} (core, #25) talks to the narrow
 * {@link DiscordStatusClient} port (no discord.js types cross into core,
 * core/AGENTS.md rule). This adapter implements that port over a live
 * discord.js {@link Client}: post a status message to a channel, or edit the
 * existing one. All discord.js coupling stays inside `gateway/`.
 */
import type { Client } from 'discord.js';

import type { DiscordStatusClient } from '../core/reporter.js';

/**
 * The narrow text-channel surface this adapter needs from a fetched channel.
 * discord.js channel unions are wide; we treat any channel exposing
 * `isTextBased() === true` as sendable and access only `send` / `messages`.
 */
interface SendableChannel {
  send(payload: { content: string }): Promise<{ id: string }>;
  messages: { fetch(id: string): Promise<{ edit(payload: { content: string }): Promise<unknown> }> };
}

export class DiscordJsStatusClient implements DiscordStatusClient {
  constructor(private readonly client: Client) {}

  async sendMessage(channelId: string, content: string): Promise<{ id: string }> {
    const channel = await this.requireSendableChannel(channelId);
    const message = await channel.send({ content });
    return { id: message.id };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.requireSendableChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit({ content });
  }

  private async requireSendableChannel(channelId: string): Promise<SendableChannel> {
    const channel = await this.client.channels.fetch(channelId);
    const textBased = (channel as { isTextBased?: () => boolean } | null)?.isTextBased?.() ?? false;
    if (channel === null || !textBased) {
      throw new Error(`discord channel ${channelId} is not a sendable text channel`);
    }
    return channel as unknown as SendableChannel;
  }
}
