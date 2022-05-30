import { BundlePolicy, RTCPeerConnection, RtcpPayloadSpecificFeedback, RTCRtpTransceiver, RtpPacket } from "@koush/werift";
import { FullIntraRequest } from "@koush/werift/lib/rtp/src/rtcp/psfb/fullIntraRequest";
import { Deferred } from "@scrypted/common/src/deferred";
import { closeQuiet, listenZeroSingleClient } from "@scrypted/common/src/listen-cluster";
import { getNaluTypesInNalu, RtspServer } from "@scrypted/common/src/rtsp-server";
import { createSdpInput, parseSdp } from '@scrypted/common/src/sdp-utils';
import sdk, { FFmpegInput, Intercom, MediaObject, MediaStreamUrl, ResponseMediaStreamOptions, RTCAVSignalingSetup, RTCSessionControl, RTCSignalingChannel, RTCSignalingOptions, RTCSignalingSendIceCandidate, RTCSignalingSession, ScryptedMimeTypes } from "@scrypted/sdk";
import dgram from 'dgram';
import { waitClosed, waitConnected } from "./peerconnection-util";
import { getFFmpegRtpAudioOutputArguments, startRtpForwarderProcess } from "./rtp-forwarders";
import { requiredAudioCodecs, requiredVideoCodec } from "./webrtc-required-codecs";
import { createRawResponse, getWeriftIceServers, isPeerConnectionAlive } from "./werift-util";

const { mediaManager } = sdk;

export interface RTCPeerConnectionPipe {
    mediaObject: MediaObject;
    intercom: Promise<Intercom>;
    pcClose: Promise<unknown>;
}

export async function createRTCPeerConnectionSource(options: {
    console: Console,
    mediaStreamOptions: ResponseMediaStreamOptions,
    channel: RTCSignalingChannel,
    maximumCompatibilityMode: boolean,
}): Promise<RTCPeerConnectionPipe> {
    const { mediaStreamOptions, channel, console, maximumCompatibilityMode } = options;

    const { clientPromise, port } = await listenZeroSingleClient();

    const timeStart = Date.now();

    const sessionControl = new Deferred<RTCSessionControl>();
    const peerConnection = new Deferred<RTCPeerConnection>();
    const intercom = new Deferred<Intercom>();

    const cleanup = () => {
        console.log('webrtc/rtsp cleaning up');
        clientPromise.then(client => client.destroy());
        sessionControl.promise.then(sc => sc.endSession());
        peerConnection.promise.then(pc => pc.close());
        intercom.promise.then(intercom => intercom.stopIntercom());
    };

    clientPromise.then(socket => socket.on('close', cleanup));

    const start = (async () => {
        const client = await clientPromise;
        const udp = dgram.createSocket('udp4');
        client.on('close', () => closeQuiet(udp));
        const rtspServer = new RtspServer(client, undefined, udp);
        // rtspServer.console = console;

        const ensurePeerConnection = (setup: RTCAVSignalingSetup) => {
            if (peerConnection.finished)
                return;
            peerConnection.resolve(new RTCPeerConnection({
                bundlePolicy: setup.configuration?.bundlePolicy as BundlePolicy,
                codecs: {
                    audio: [
                        ...requiredAudioCodecs,
                    ],
                    video: [
                        requiredVideoCodec,
                    ],
                },
                iceServers: getWeriftIceServers(setup.configuration),
            }));
        }

        let audioTrack: string;
        let videoTrack: string;
        let audioTransceiver: RTCRtpTransceiver;

        const doSetup = async (setup: RTCAVSignalingSetup) => {
            ensurePeerConnection(setup);

            let gotAudio = false;
            let gotVideo = false;

            const pc = await peerConnection.promise;
            audioTransceiver = pc.addTransceiver("audio", setup.audio as any);
            audioTransceiver.onTrack.subscribe((track) => {
                track.onReceiveRtp.subscribe(rtp => {
                    if (!gotAudio) {
                        gotAudio = true;
                        console.log('first audio packet', Date.now() - timeStart);
                    }
                    rtspServer.sendTrack(audioTrack, rtp.serialize(), false);
                });
                track.onReceiveRtcp.subscribe(rtp => rtspServer.sendTrack(audioTrack, rtp.serialize(), true));
            });

            const videoTransceiver = pc.addTransceiver("video", setup.video as any);
            videoTransceiver.onTrack.subscribe((track) => {
                track.onReceiveRtp.subscribe(rtp => {
                    if (!gotVideo) {
                        gotVideo = true;
                        console.log('first video packet', Date.now() - timeStart);
                        const naluTypes = getNaluTypesInNalu(rtp.payload);
                        console.log('video packet types', ...[...naluTypes]);
                    }
                    rtspServer.sendTrack(videoTrack, rtp.serialize(), false);
                });
                track.onReceiveRtcp.subscribe(rtp => rtspServer.sendTrack(videoTrack, rtp.serialize(), true));

                track.onReceiveRtp.once(() => {
                    let firSequenceNumber = 0;
                    const pictureLossInterval = setInterval(() => {
                        // i think this is necessary for older clients like ring
                        // which is really a sip gateway?
                        const fir = new FullIntraRequest({
                            senderSsrc: videoTransceiver.receiver.rtcpSsrc,
                            mediaSsrc: track.ssrc,
                            fir: [
                                {
                                    sequenceNumber: firSequenceNumber++,
                                    ssrc: track.ssrc,
                                }
                            ]
                        });
                        const packet = new RtcpPayloadSpecificFeedback({
                            feedback: fir,
                        });
                        videoTransceiver.receiver.dtlsTransport.sendRtcp([packet]);

                        // from my testing with browser clients, the pli is what
                        // triggers a i-frame to be sent, and not the prior FIR request.
                        videoTransceiver.receiver.sendRtcpPLI(track.ssrc!);
                    }, 4000);
                    waitClosed(pc).then(() => clearInterval(pictureLossInterval));
                });
            });
        }

        const handleRtspSetup = async (description: RTCSessionDescriptionInit) => {
            if (description.type !== 'answer')
                throw new Error('rtsp setup needs answer sdp');

            rtspServer.sdp = createSdpInput(0, 0, description.sdp);
            const parsedSdp = parseSdp(rtspServer.sdp);
            audioTrack = parsedSdp.msections.find(msection => msection.type === 'audio').control;
            videoTrack = parsedSdp.msections.find(msection => msection.type === 'video').control;
            // console.log('sdp sent', rtspServer.sdp);

            await rtspServer.handlePlayback();
            console.log('rtsp server playback started');
        }

        class SignalingSession implements RTCSignalingSession {
            getOptions(): Promise<RTCSignalingOptions> {
                return;
            }

            async createLocalDescription(type: "offer" | "answer", setup: RTCAVSignalingSetup, sendIceCandidate: RTCSignalingSendIceCandidate): Promise<RTCSessionDescriptionInit> {
                if (type === 'offer')
                    doSetup(setup);
                const pc = await peerConnection.promise;
                if (setup.datachannel)
                    pc.createDataChannel(setup.datachannel.label, setup.datachannel.dict);

                const gatheringPromise = pc.iceGatheringState === 'complete' ? Promise.resolve(undefined) : new Promise(resolve => pc.iceGatheringStateChange.subscribe(state => {
                    if (state === 'complete')
                        resolve(undefined);
                }));

                if (sendIceCandidate) {
                    pc.onicecandidate = ev => {
                        console.log('sendIceCandidate', ev.candidate.sdpMLineIndex, ev.candidate.candidate);
                        sendIceCandidate({
                            ...ev.candidate,
                        });
                    };
                }

                if (type === 'answer') {
                    let answer = await pc.createAnswer();
                    console.log('createLocalDescription', answer.sdp)
                    const ret = createRawResponse(answer);
                    await handleRtspSetup(ret);
                    const set = pc.setLocalDescription(answer);
                    if (sendIceCandidate)
                        return ret;
                    await set;
                    await gatheringPromise;
                    answer = pc.localDescription || answer;
                    return createRawResponse(answer);
                }
                else {
                    let offer = await pc.createOffer();
                    console.log('createLocalDescription', offer.sdp)
                    const set = pc.setLocalDescription(offer);
                    if (sendIceCandidate)
                        return createRawResponse(offer);
                    await set;
                    await gatheringPromise;
                    offer = await pc.createOffer();
                    return createRawResponse(offer);
                }
            }
            async setRemoteDescription(description: RTCSessionDescriptionInit, setup: RTCAVSignalingSetup): Promise<void> {
                console.log('setRemoteDescription', description.sdp)
                if (description.type === 'offer')
                    doSetup(setup);
                else
                    await handleRtspSetup(description);
                const pc = await peerConnection.promise;
                await pc.setRemoteDescription(description as any);
            }
            async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
                console.log('addIceCandidate', candidate.sdpMLineIndex, candidate.candidate)
                const pc = await peerConnection.promise;
                await pc.addIceCandidate(candidate as RTCIceCandidate);
            }
        }

        const session = new SignalingSession();
        const sc = await channel.startRTCSignalingSession(session);
        sessionControl.resolve(sc);
        const pc = await peerConnection.promise;
        await waitConnected(pc);

        let destroyProcess: () => void;

        const track = audioTransceiver.sender.sendRtp;

        const ic: Intercom = {
            async startIntercom(media: MediaObject) {
                if (!isPeerConnectionAlive(pc))
                    throw new Error('peer connection is closed');

                if (!track)
                    throw new Error('peer connection does not support two way audio');


                const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

                const { kill: destroy } = await startRtpForwarderProcess(console, ffmpegInput, {
                    audio: {
                        outputArguments: getFFmpegRtpAudioOutputArguments(ffmpegInput.mediaStreamOptions?.audio?.codec, maximumCompatibilityMode),
                        onRtp: (rtp) => audioTransceiver.sender.sendRtp(rtp),
                    },
                });

                ic.stopIntercom();

                destroyProcess = destroy;

                const sc = await sessionControl.promise;
                sc.setPlayback({
                    audio: true,
                    video: false,
                });
            },
            async stopIntercom() {
                destroyProcess?.();

                sc.setPlayback({
                    audio: false,
                    video: false,
                });
            },
        };

        intercom.resolve(ic);
    })();

    start.catch(e => {
        console.error('session start failed', e);
        sessionControl.reject(e);
        peerConnection.reject(e);
        intercom.reject(e);
    });

    const pcClose = peerConnection.promise.then(pc => waitClosed(pc));
    pcClose.finally(cleanup);

    peerConnection.promise.catch(e => {
        console.error('failed to create webrtc signaling session', e);
        cleanup();
    });

    const url = `rtsp://127.0.0.1:${port}`;
    const mediaStreamUrl: MediaStreamUrl = {
        url,
        container: 'rtsp',
        mediaStreamOptions,
    };

    return {
        mediaObject: await mediaManager.createMediaObject(mediaStreamUrl, ScryptedMimeTypes.MediaStreamUrl),
        intercom: intercom.promise,
        pcClose,
    };
}

interface ReceivedRtpPacket extends RtpPacket {
    uptime?: number;
}

export function getRTCMediaStreamOptions(id: string, name: string): ResponseMediaStreamOptions {
    return {
        // set by consumer
        id,
        name,
        // not compatible with scrypted parser currently due to jitter issues
        tool: 'scrypted',
        container: 'rtsp',
        video: {
            codec: 'h264',
        },
        audio: {
        },
    };
}
