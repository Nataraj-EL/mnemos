export interface Conversation {
  id: string;
  userId: string;
  startedAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  transcript: string;
  summary?: string;
  createdAt: Date;
}
