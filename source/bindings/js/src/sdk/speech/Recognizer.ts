import {
    ArgumentNullError,
    ConnectionMessage,
    ConnectionOpenResponse,
    ConnectionState,
    CreateNoDashGuid,
    Deferred,
    Events,
    IAudioSource,
    IAudioStreamNode,
    IConnection,
    IDetachable,
    IEventSource,
    IStreamChunk,
    MessageType,
    PlatformEvent,
    Promise,
    PromiseHelper,
    PromiseResult,
} from "../../common/Exports";
import { AuthInfo, IAuthentication } from "./IAuthentication";
import { IConnectionFactory } from "./IConnectionFactory";
import {
    ConnectingToServiceEvent,
    ListeningStartedEvent,
    RecognitionCompletionStatus,
    RecognitionEndedEvent,
    RecognitionStartedEvent,
    RecognitionTriggeredEvent,
    SpeechDetailedPhraseEvent,
    SpeechEndDetectedEvent,
    SpeechFragmentEvent,
    SpeechHypothesisEvent,
    SpeechRecognitionEvent,
    SpeechRecognitionResultEvent,
    SpeechSimplePhraseEvent,
    SpeechStartDetectedEvent,
    TranslationFailedEvent,
    TranslationHypothesisEvent,
    TranslationSimplePhraseEvent,
} from "./RecognitionEvents";
import { RecognitionMode, RecognizerConfig, SpeechResultFormat } from "./RecognizerConfig";
import { ServiceTelemetryListener } from "./ServiceTelemetryListener.Internal";
import { SpeechConnectionMessage } from "./SpeechConnectionMessage.Internal";
import {
    IDetailedSpeechPhrase,
    ISimpleSpeechPhrase,
    ISpeechEndDetectedResult,
    ISpeechFragment,
    ISpeechStartDetectedResult,
    ITranslationFragment,
    ITranslationPhrase,
    RecognitionStatus2,
} from "./SpeechResults";

export abstract class ServiceRecognizerBase {
    private authentication: IAuthentication;
    private connectionFactory: IConnectionFactory;
    private audioSource: IAudioSource;
    private speechConfigConnectionId: string;
    private connectionFetchPromise: Promise<IConnection>;
    private connectionId: string;
    private authFetchEventId: string;
    protected recognizerConfig: RecognizerConfig;

    public constructor(
        authentication: IAuthentication,
        connectionFactory: IConnectionFactory,
        audioSource: IAudioSource,
        recognizerConfig: RecognizerConfig) {

        if (!authentication) {
            throw new ArgumentNullError("authentication");
        }

        if (!connectionFactory) {
            throw new ArgumentNullError("connectionFactory");
        }

        if (!audioSource) {
            throw new ArgumentNullError("audioSource");
        }

        if (!recognizerConfig) {
            throw new ArgumentNullError("recognizerConfig");
        }

        this.authentication = authentication;
        this.connectionFactory = connectionFactory;
        this.audioSource = audioSource;
        this.recognizerConfig = recognizerConfig;
    }

    public get AudioSource(): IAudioSource {
        return this.audioSource;
    }

    public Recognize = (onEventCallback: (event: SpeechRecognitionEvent) => void, speechContextJson?: string): Promise<boolean> => {
        const requestSession = this.GetSession(this.audioSource.Id(), onEventCallback);

        requestSession.ListenForServiceTelemetry(this.audioSource.Events);

        return this.audioSource
            .Attach(requestSession.AudioNodeId)
            .ContinueWithPromise<boolean>((result: PromiseResult<IAudioStreamNode>) => {
                if (result.IsError) {
                    requestSession.OnAudioSourceAttachCompleted(null, true, result.Error);
                    throw new Error(result.Error);
                } else {
                    requestSession.OnAudioSourceAttachCompleted(result.Result, false);
                }

                const audioNode = result.Result;

                this.FetchConnection(requestSession)
                    .OnSuccessContinueWith((connection: IConnection) => {
                        const messageRetrievalPromise = this.ReceiveMessage(connection, requestSession);
                        const messageSendPromise = this.SendSpeechConfig(requestSession.RequestId, connection, this.recognizerConfig.SpeechConfig.Serialize())
                            .OnSuccessContinueWithPromise((_: boolean) => {
                                return this.SendSpeechContext(requestSession.RequestId, connection, speechContextJson)
                                    .OnSuccessContinueWithPromise((_: boolean) => {
                                        return this.SendAudio(requestSession.RequestId, connection, audioNode, requestSession);
                                    });
                            });

                        const completionPromise = PromiseHelper.WhenAll([messageRetrievalPromise, messageSendPromise]);

                        completionPromise.On((r: boolean) => {
                            requestSession.Dispose();
                            this.SendTelemetryData(requestSession.RequestId, connection, requestSession.GetTelemetry());
                        }, (error: string) => {
                            requestSession.Dispose(error);
                            this.SendTelemetryData(requestSession.RequestId, connection, requestSession.GetTelemetry());
                        });

                        return completionPromise;
                    });

                return requestSession.CompletionPromise;
            });
    }

    protected abstract GetSession(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void): RequestSessionBase;

    protected abstract ProcessTypeSpecificMessages(message: SpeechConnectionMessage, session: RequestSessionBase, connection: IConnection): void;

    protected SendTelemetryData = (requestId: string, connection: IConnection, telemetryData: string) => {
        return connection
            .Send(new SpeechConnectionMessage(
                MessageType.Text,
                "telemetry",
                requestId,
                "application/json",
                telemetryData));
    }

    private FetchConnection = (requestSession: RequestSessionBase, isUnAuthorized: boolean = false): Promise<IConnection> => {
        if (this.connectionFetchPromise) {
            if (this.connectionFetchPromise.Result().IsError
                || this.connectionFetchPromise.Result().Result.State() === ConnectionState.Disconnected) {
                this.connectionId = null;
                this.connectionFetchPromise = null;
                return this.FetchConnection(requestSession);
            } else {
                requestSession.OnPreConnectionStart(this.authFetchEventId, this.connectionId);
                requestSession.OnConnectionEstablishCompleted(200);
                requestSession.ListenForServiceTelemetry(this.connectionFetchPromise.Result().Result.Events);
                return this.connectionFetchPromise;
            }
        }

        this.authFetchEventId = CreateNoDashGuid();
        this.connectionId = CreateNoDashGuid();

        requestSession.OnPreConnectionStart(this.authFetchEventId, this.connectionId);

        const authPromise = isUnAuthorized ? this.authentication.FetchOnExpiry(this.authFetchEventId) : this.authentication.Fetch(this.authFetchEventId);

        this.connectionFetchPromise = authPromise
            .ContinueWithPromise((result: PromiseResult<AuthInfo>) => {
                if (result.IsError) {
                    requestSession.OnAuthCompleted(true, result.Error);
                    throw new Error(result.Error);
                } else {
                    requestSession.OnAuthCompleted(false);
                }

                const connection = this.connectionFactory.Create(this.recognizerConfig, result.Result, this.connectionId);
                requestSession.ListenForServiceTelemetry(connection.Events);

                return connection.Open().OnSuccessContinueWithPromise((response: ConnectionOpenResponse) => {
                    if (response.StatusCode === 200) {
                        requestSession.OnConnectionEstablishCompleted(response.StatusCode);
                        return PromiseHelper.FromResult(connection);
                    } else if (response.StatusCode === 403 && !isUnAuthorized) {
                        return this.FetchConnection(requestSession, true);
                    } else {
                        requestSession.OnConnectionEstablishCompleted(response.StatusCode, response.Reason);
                        return PromiseHelper.FromError<IConnection>(`Unable to contact server. StatusCode: ${response.StatusCode}, Reason: ${response.Reason}`);
                    }
                });
            });

        return this.connectionFetchPromise;
    }

    private ReceiveMessage = (connection: IConnection, requestSession: RequestSessionBase): Promise<boolean> => {
        return connection
            .Read()
            .OnSuccessContinueWithPromise((message: ConnectionMessage) => {
                const connectionMessage = SpeechConnectionMessage.FromConnectionMessage(message);
                if (connectionMessage.RequestId.toLowerCase() === requestSession.RequestId.toLowerCase()) {
                    switch (connectionMessage.Path.toLowerCase()) {
                        case "turn.start":
                            requestSession.OnServiceTurnStartResponse(JSON.parse(connectionMessage.TextBody));
                            break;
                        case "speech.startdetected":
                            requestSession.OnServiceSpeechStartDetectedResponse(JSON.parse(connectionMessage.TextBody));
                            break;
                        case "speech.fragment":
                            requestSession.OnServiceSpeechFragmentResponse(JSON.parse(connectionMessage.TextBody));
                            break;
                        case "speech.enddetected":
                            if (connectionMessage.TextBody.length > 0) {
                                requestSession.OnServiceSpeechEndDetectedResponse(JSON.parse(connectionMessage.TextBody));
                            } else {
                                // If the request was empty, the JSON returned is empty.
                                requestSession.OnServiceSpeechEndDetectedResponse({ Offset: 0 });
                            }
                            break;
                        case "turn.end":
                            requestSession.OnServiceTurnEndResponse();
                            return PromiseHelper.FromResult(true);
                        default:
                            this.ProcessTypeSpecificMessages(connectionMessage, requestSession, connection);
                    }
                }

                return this.ReceiveMessage(connection, requestSession);
            });
    }

    private SendSpeechConfig = (requestId: string, connection: IConnection, speechConfigJson: string) => {
        if (speechConfigJson && this.connectionId !== this.speechConfigConnectionId) {
            this.speechConfigConnectionId = this.connectionId;
            return connection
                .Send(new SpeechConnectionMessage(
                    MessageType.Text,
                    "speech.config",
                    requestId,
                    "application/json",
                    speechConfigJson));
        }

        return PromiseHelper.FromResult(true);
    }

    private SendSpeechContext = (requestId: string, connection: IConnection, speechContextJson: string) => {
        if (speechContextJson) {
            return connection
                .Send(new SpeechConnectionMessage(
                    MessageType.Text,
                    "speech.context",
                    requestId,
                    "application/json",
                    speechContextJson));
        }
        return PromiseHelper.FromResult(true);
    }

    private SendAudio = (
        requestId: string,
        connection: IConnection,
        audioStreamNode: IAudioStreamNode,
        requestSession: RequestSessionBase): Promise<boolean> => {
        // NOTE: Home-baked promises crash ios safari during the invocation
        // of the error callback chain (looks like the recursion is way too deep, and
        // it blows up the stack). The following construct is a stop-gap that does not
        // bubble the error up the callback chain and hence circumvents this problem.
        // TODO: rewrite with ES6 promises.
        const deferred = new Deferred<boolean>();

        const readAndUploadCycle = (_: boolean) => {
            audioStreamNode.Read().On(
                (audioStreamChunk: IStreamChunk<ArrayBuffer>) => {
                    // we have a new audio chunk to upload.
                    if (requestSession.IsSpeechEnded) {
                        // If service already recognized audio end then dont send any more audio
                        deferred.Resolve(true);
                        return;
                    }

                    const payload = (audioStreamChunk.IsEnd) ? null : audioStreamChunk.Buffer;
                    const uploaded = connection.Send(
                        new SpeechConnectionMessage(
                            MessageType.Binary, "audio", requestId, null, payload));

                    if (!audioStreamChunk.IsEnd) {
                        uploaded.OnSuccessContinueWith(readAndUploadCycle);
                    } else {
                        // the audio stream has been closed, no need to schedule next
                        // read-upload cycle.
                        deferred.Resolve(true);
                    }
                },
                (error: string) => {
                    if (requestSession.IsSpeechEnded) {
                        // For whatever reason, Reject is used to remove queue subscribers inside
                        // the Queue.DrainAndDispose invoked from DetachAudioNode down blow, which
                        // means that sometimes things can be rejected in normal circumstances, without
                        // any errors.
                        deferred.Resolve(true); // TODO: remove the argument, it's is completely meaningless.
                    } else {
                        // Only reject, if there was a proper error.
                        deferred.Reject(error);
                    }
                });
        };

        readAndUploadCycle(true);

        return deferred.Promise();
    }
}

// tslint:disable-next-line:max-classes-per-file
export class SpeechServiceRecognizer extends ServiceRecognizerBase {

    public constructor(
        authentication: IAuthentication,
        connectionFactory: IConnectionFactory,
        audioSource: IAudioSource,
        recognizerConfig: RecognizerConfig) {
        super(authentication, connectionFactory, audioSource, recognizerConfig);
    }

    protected GetSession(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void): RequestSessionBase {
        return new SpeechRequestSession(audioSourceId, onEventCallback);
    }

    protected ProcessTypeSpecificMessages(connectionMessage: SpeechConnectionMessage, session: RequestSessionBase, connection: IConnection): void {
        const requestSession: SpeechRequestSession = session as SpeechRequestSession;

        switch (connectionMessage.Path.toLowerCase()) {
            case "speech.hypothesis":
                requestSession.OnServiceSpeechHypothesisResponse(JSON.parse(connectionMessage.TextBody));
                break;
            case "speech.phrase":
                if (this.recognizerConfig.IsContinuousRecognition) {
                    // For continuous recognition telemetry has to be sent for every phrase as per spec.
                    this.SendTelemetryData(requestSession.RequestId, connection, requestSession.GetTelemetry());
                }
                if (this.recognizerConfig.Format === SpeechResultFormat.Simple) {
                    requestSession.OnServiceSimpleSpeechPhraseResponse(JSON.parse(connectionMessage.TextBody));
                } else {
                    requestSession.OnServiceDetailedSpeechPhraseResponse(JSON.parse(connectionMessage.TextBody));
                }
                break;
            default:
                break;
        }
    }
}

// tslint:disable-next-line:max-classes-per-file
export class TranslationServiceRecognizer extends ServiceRecognizerBase {

    public constructor(
        authentication: IAuthentication,
        connectionFactory: IConnectionFactory,
        audioSource: IAudioSource,
        recognizerConfig: RecognizerConfig) {
        super(authentication, connectionFactory, audioSource, recognizerConfig);
    }

    protected GetSession(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void): RequestSessionBase {
        return new TranslationRequestSession(audioSourceId, onEventCallback);
    }

    protected ProcessTypeSpecificMessages(connectionMessage: SpeechConnectionMessage, session: RequestSessionBase, connection: IConnection): void {
        const requestSession: TranslationRequestSession = session as TranslationRequestSession;

        switch (connectionMessage.Path.toLowerCase()) {
            case "translation.hypothesis":
                requestSession.OnServiceTranslationHypothesisResponse(JSON.parse(connectionMessage.TextBody));
                break;
            case "translation.phrase":
                if (this.recognizerConfig.IsContinuousRecognition) {
                    // For continuous recognition telemetry has to be sent for every phrase as per spec.
                    this.SendTelemetryData(requestSession.RequestId, connection, requestSession.GetTelemetry());
                }

                const translatedPhrase: ITranslationPhrase = JSON.parse(connectionMessage.TextBody);

                // Make sure the reason is an enumn and not a string.
                const status2: string = "" + translatedPhrase.RecognitionStatus;
                const recstatus2 = (RecognitionStatus2 as any)[status2];

                if (recstatus2 !== RecognitionStatus2.Error) {
                    requestSession.OnServiceSimpleTranslationPhraseResponse(JSON.parse(connectionMessage.TextBody));
                } else {
                    requestSession.OnServiceTranslationErrorResponse(translatedPhrase);
                }

                break;
            default:
                break;
        }
    }
}

// tslint:disable-next-line:max-classes-per-file
export abstract class RequestSessionBase {
    private isDisposed: boolean = false;
    private serviceTelemetryListener: ServiceTelemetryListener;
    private detachables: IDetachable[] = new Array<IDetachable>();
    private requestId: string;
    private audioSourceId: string;
    private audioNodeId: string;
    private audioNode: IAudioStreamNode;
    private authFetchEventId: string;
    private serviceTag: string;
    private isAudioNodeDetached: boolean = false;
    private isCompleted: boolean = false;
    private onEventCallback: (event: SpeechRecognitionEvent) => void;

    private requestCompletionDeferral: Deferred<boolean>;

    protected sessionId: string;

    constructor(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void) {
        this.audioSourceId = audioSourceId;
        this.onEventCallback = onEventCallback;
        this.requestId = CreateNoDashGuid();
        this.audioNodeId = CreateNoDashGuid();
        this.requestCompletionDeferral = new Deferred<boolean>();

        this.serviceTelemetryListener = new ServiceTelemetryListener(this.requestId, this.audioSourceId, this.audioNodeId);

        this.OnEvent(new RecognitionTriggeredEvent(this.RequestId, this.sessionId, this.audioSourceId, this.audioNodeId));
    }

    public get RequestId(): string {
        return this.requestId;
    }

    public get AudioNodeId(): string {
        return this.audioNodeId;
    }

    public get CompletionPromise(): Promise<boolean> {
        return this.requestCompletionDeferral.Promise();
    }

    public get IsSpeechEnded(): boolean {
        return this.isAudioNodeDetached;
    }

    public get IsCompleted(): boolean {
        return this.isCompleted;
    }

    public ListenForServiceTelemetry(eventSource: IEventSource<PlatformEvent>): void {
        this.detachables.push(eventSource.AttachListener(this.serviceTelemetryListener));
    }

    public OnAudioSourceAttachCompleted = (audioNode: IAudioStreamNode, isError: boolean, error?: string): void => {
        this.audioNode = audioNode;
        if (isError) {
            this.OnComplete(RecognitionCompletionStatus.AudioSourceError, error);
        } else {
            this.OnEvent(new ListeningStartedEvent(this.requestId, this.sessionId, this.audioSourceId, this.audioNodeId));
        }
    }

    public OnPreConnectionStart = (authFetchEventId: string, connectionId: string): void => {
        this.authFetchEventId = authFetchEventId;
        this.sessionId = connectionId;
        this.OnEvent(new ConnectingToServiceEvent(this.requestId, this.authFetchEventId, this.sessionId));
    }

    public OnAuthCompleted = (isError: boolean, error?: string): void => {
        if (isError) {
            this.OnComplete(RecognitionCompletionStatus.AuthTokenFetchError, error);
        }
    }

    public OnConnectionEstablishCompleted = (statusCode: number, reason?: string): void => {
        if (statusCode === 200) {
            this.OnEvent(new RecognitionStartedEvent(this.RequestId, this.audioSourceId, this.audioNodeId, this.authFetchEventId, this.sessionId));
            return;
        } else if (statusCode === 403) {
            this.OnComplete(RecognitionCompletionStatus.UnAuthorized, reason);
        } else {
            this.OnComplete(RecognitionCompletionStatus.ConnectError, reason);
        }
    }

    public OnServiceTurnStartResponse = (response: ITurnStartResponse): void => {
        if (response && response.context && response.context.serviceTag) {
            this.serviceTag = response.context.serviceTag;
        }
    }

    public OnServiceSpeechStartDetectedResponse = (result: ISpeechStartDetectedResult): void => {
        this.OnEvent(new SpeechStartDetectedEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceSpeechFragmentResponse = (result: ISpeechFragment): void => {
        this.OnEvent(new SpeechFragmentEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceSpeechEndDetectedResponse = (result: ISpeechEndDetectedResult): void => {
        this.DetachAudioNode();
        this.OnEvent(new SpeechEndDetectedEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceTurnEndResponse = (): void => {
        this.OnComplete(RecognitionCompletionStatus.Success);
    }

    public OnConnectionError = (error: string): void => {
        this.OnComplete(RecognitionCompletionStatus.UnknownError, error);
    }

    public Dispose = (error?: string): void => {
        if (!this.isDisposed) {
            // we should have completed by now. If we did not its an unknown error.
            this.OnComplete(RecognitionCompletionStatus.UnknownError, error);
            this.isDisposed = true;
            for (const detachable of this.detachables) {
                detachable.Detach();
            }

            this.serviceTelemetryListener.Dispose();
        }
    }

    public GetTelemetry = (): string => {
        return this.serviceTelemetryListener.GetTelemetry();
    }

    protected OnEvent = (event: SpeechRecognitionEvent): void => {
        this.serviceTelemetryListener.OnEvent(event);
        Events.Instance.OnEvent(event);
        if (this.onEventCallback) {
            this.onEventCallback(event);
        }
    }

    private OnComplete = (status: RecognitionCompletionStatus, error?: string): void => {
        if (!this.isCompleted) {
            this.isCompleted = true;
            this.DetachAudioNode();
            this.OnEvent(new RecognitionEndedEvent(this.RequestId, this.audioSourceId, this.audioNodeId, this.authFetchEventId, this.sessionId, this.serviceTag, status, error ? error : ""));
        }
    }

    private DetachAudioNode = (): void => {
        if (!this.isAudioNodeDetached) {
            this.isAudioNodeDetached = true;
            if (this.audioNode) {
                this.audioNode.Detach();
            }
        }
    }
}

// tslint:disable-next-line:max-classes-per-file
class SpeechRequestSession extends RequestSessionBase {
    constructor(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void) {
        super(audioSourceId, onEventCallback);
    }

    public OnServiceSpeechHypothesisResponse = (result: ISpeechFragment): void => {
        this.OnEvent(new SpeechHypothesisEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceSimpleSpeechPhraseResponse = (result: ISimpleSpeechPhrase): void => {
        this.OnEvent(new SpeechSimplePhraseEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceDetailedSpeechPhraseResponse = (result: IDetailedSpeechPhrase): void => {
        this.OnEvent(new SpeechDetailedPhraseEvent(this.RequestId, this.sessionId, result));
    }
}

// tslint:disable-next-line:max-classes-per-file
class TranslationRequestSession extends RequestSessionBase {
    constructor(audioSourceId: string, onEventCallback: (event: SpeechRecognitionEvent) => void) {
        super(audioSourceId, onEventCallback);
    }

    public OnServiceTranslationHypothesisResponse = (result: ITranslationFragment): void => {
        this.OnEvent(new TranslationHypothesisEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceSimpleTranslationPhraseResponse = (result: ITranslationFragment): void => {
        this.OnEvent(new TranslationSimplePhraseEvent(this.RequestId, this.sessionId, result));
    }

    public OnServiceTranslationErrorResponse = (result: ITranslationPhrase): void => {
        this.OnEvent(new TranslationFailedEvent(this.RequestId, this.sessionId, result));
    }
}

export interface ITurnStartResponse {
    context: ITurnStartContext;
}

export interface ITurnStartContext {
    serviceTag: string;
}
