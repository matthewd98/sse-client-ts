const enum JsonChars {
    StartObject = 123, // = '{'
    EndObject = 125, // = '}'
}

export class SseClient {
    private _url: string;

    private _init?: RequestInit;

    private _onMessage: (ev: string) => void;

    private _onOpen?: () => void;

    private _onClose?: () => void;

    private _reader?: ReadableStreamReader;

    private _controller: AbortController = new AbortController();

    private _decoder: TextDecoder = new TextDecoder();

    constructor(url: string, onMessage: (ev: string) => void, onOpen?: () => void, onClose?: () => void, init?: RequestInit) {
        this._url = url;
        this._onMessage = onMessage;
        this._onOpen = onOpen;
        this._onClose = onClose;
        this._init = init;

        // Set accept header value
        if (this._init?.headers) {
            this._init.headers = { ...this._init.headers, accept: 'text/event-stream' };
        }
    }

    public async start(): Promise<void> {
        const signal = this._controller.signal;

        const response = await fetch(this._url, { signal, ...this._init });

        if (response.ok) {
            if (this._onOpen) {
                this._onOpen();
            }

            this._reader = response.body!.getReader();
            await this.processStreamChunks(this._reader);
        } else {
            const responseBody = await response.text();
            throw new Error(responseBody);
        }
    }

    // Assumes: multiple JSON objects in the same stream chunk and no delimiter characters between events other than the JSON start and end object characters
    private async processStreamChunks(reader: ReadableStreamReader<Uint8Array>): Promise<void> {
        let buffer: Uint8Array = new Uint8Array();
        let jsonObjectCharCounter: number = 0;

        while (true) {
            const { done, value } = await reader.read();

            if (!value) return;

            if (done) {
                if (this._onClose) {
                    this._onClose();
                }
                break;
            }

            let positionJsonObjectEnd: number = -1;
            for (let position = 0; position < value.length; position++) {
                if (value[position] == JsonChars.StartObject) {
                    ++jsonObjectCharCounter;
                } else if (value[position] == JsonChars.EndObject) {
                    --jsonObjectCharCounter;

                    // Reached end of object
                    if (jsonObjectCharCounter == 0) {
                        let jsonObjectStringArray = value.subarray(positionJsonObjectEnd + 1, position + 1);

                        positionJsonObjectEnd = position;

                        // Recombine with previous chunk(s)
                        if (buffer.length != 0) {
                            jsonObjectStringArray = this.concatBuffers(buffer, jsonObjectStringArray);
                            buffer = new Uint8Array();
                        }

                        let decodedJsonObjectString = this._decoder.decode(jsonObjectStringArray);
                        this._onMessage(decodedJsonObjectString);
                    }
                }

                // Store JSON object chunk to be recombined with next incoming chunk(s)
                if (position == value.length - 1 && jsonObjectCharCounter != 0) {
                    let jsonObjectChunk = value.subarray(positionJsonObjectEnd + 1, position + 1);
                    buffer = this.concatBuffers(buffer, jsonObjectChunk);
                }
            }
        }

        reader.releaseLock();
    }

    public closeStream(): void {
        this._reader?.cancel();
    }

    private concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
        const res = new Uint8Array(a.length + b.length);
        res.set(a);
        res.set(b, a.length);
        return res;
    }
}