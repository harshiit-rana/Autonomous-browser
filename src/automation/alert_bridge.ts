/**
 * Project Aegis - Headless WhatsApp & Messaging Alert Bridge
 * 
 * Implements:
 * - Issue #82: DATA-06 Headless WhatsApp & Messaging Alert Bridge
 */

export interface AlertMessage {
  channel: 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'webhook';
  recipient?: string;
  title: string;
  body: string;
  actionUrl?: string;
  timestamp: number;
}

export interface AlertChannelConfig {
  channel: AlertMessage['channel'];
  webhookUrl: string;
  authToken?: string;
}

export class MessagingAlertBridge {
  private channels: Map<string, AlertChannelConfig> = new Map();

  public registerChannel(id: string, config: AlertChannelConfig): void {
    this.channels.set(id, config);
  }

  /**
   * Sends an alert notification through the specified configured channel.
   */
  public async sendAlert(channelId: string, alert: Omit<AlertMessage, 'timestamp'>): Promise<boolean> {
    const config = this.channels.get(channelId);
    if (!config) {
      console.warn(`[AlertBridge] Channel "${channelId}" not configured.`);
      return false;
    }

    const payload = {
      ...alert,
      timestamp: Date.now()
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.authToken) {
        headers['Authorization'] = `Bearer ${config.authToken}`;
      }

      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      return res.ok;
    } catch (err) {
      console.warn(`[AlertBridge] Failed to dispatch alert to ${channelId}:`, err);
      return false;
    }
  }
}
