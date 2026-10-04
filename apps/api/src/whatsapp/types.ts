export type DownloadedMedia = {
  bytes: Buffer;
  mimeType: string;
  filename?: string;
};

export type IncomingWhatsAppMessage = {
  providerMessageId: string;
  conversationId: string;
  from: string;
  kind: 'text' | 'image' | 'pdf' | 'unsupported';
  text?: string;
  media?: DownloadedMedia;
};

export type IncomingMessageHandler = (
  message: IncomingWhatsAppMessage,
) => Promise<string | undefined>;
