/** Stable, session-scoped metadata shared by retained providers. */
export function buildSessionMetadata(sessionId: string): Record<string, unknown> {
	return { user_id: JSON.stringify({ session_id: sessionId }) };
}
