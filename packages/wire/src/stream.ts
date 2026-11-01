/** Screen shapes shared by local terminal recordings. */

/** History rows retained by local recording playback; older rows fall off the top. */
export const STREAM_HISTORY_LIMIT = 2000;

/** One terminal row: ANSI text limited to SGR + OSC 8, width-truncated. */
export type StreamRow = string;
