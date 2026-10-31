export * as claudeCode from "./claude-code/transcript.ts";
export * as git from "./git/git.ts";
export * as hooks from "./claude-code/hooks.ts";
export * as hookInstall from "./claude-code/install.ts";
export { FsCapture } from "./fs/watcher.ts";
export { type RecorderOptions, Recorder, importChangedTranscripts, importGitIfChanged, transcriptFiles, liveRecorder, lastHeartbeat, HEARTBEAT_TTL_MS, pausedWindows, addPausedWindow, withoutPaused } from "./recorder.ts";
