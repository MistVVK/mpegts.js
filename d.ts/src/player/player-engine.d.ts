import type MediaInfo from "../core/media-info";
export default interface PlayerEngine {
    destroy(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    attachMediaElement(mediaElement: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    configureLiveSync(config: {
        liveSync: boolean;
        liveSyncMaxLatency?: number;
        liveSyncTargetLatency?: number;
        liveSyncPlaybackRate?: number;
    }): void;
    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    switchPrimaryAudio(): void;
    switchSecondaryAudio(): void;
    switchAudioTrack(index: number): void;
    readonly mediaInfo: MediaInfo | undefined;
    readonly statisticsInfo: any | undefined;
}
