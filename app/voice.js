import { Writable, Transform } from 'stream'
import MicrophoneStream from 'microphone-stream'
import audioContext from 'audio-context'
import chunker from 'stream-chunker'
import Resampler from 'libsamplerate.js'
import getUserMedia from 'getusermedia'
import keyboardjs from 'keyboardjs'
import vad from 'voice-activity-detection'
import DropStream from 'drop-stream'

class VoiceHandler extends Writable {
  constructor (client) {
    super({ objectMode: true })
    this._client = client
    this._outbound = null
  }

  _getOrCreateOutbound () {
    if (!this._outbound) {
      if (!this._client) {
        this._outbound = DropStream.obj()
        this.emit('started_talking')
        return this._outbound
      }
      this._outbound = new Resampler({
        unsafe: true,
        type: Resampler.Type.SINC_FASTEST,
        ratio: 48000 / audioContext.sampleRate
      })

      const buffer2Float32Array = new Transform({
        transform (data, _, callback) {
          callback(null, new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4))
        },
        readableObjectMode: true
      })

      this._outbound
        .pipe(chunker(4 * 480))
        .pipe(buffer2Float32Array)
        .pipe(this._client.createVoiceStream())

      this.emit('started_talking')
    }
    return this._outbound
  }

  _stopOutbound () {
    if (this._outbound) {
      this.emit('stopped_talking')
      this._outbound.end()
      this._outbound = null
    }
  }

  _final (callback) {
    this._stopOutbound()
    callback()
  }
}

export class ContinuousVoiceHandler extends VoiceHandler {
  constructor (client) {
    super(client)
  }

  _write (data, _, callback) {
    this._getOrCreateOutbound().write(data, callback)
  }
}

export class PushToTalkVoiceHandler extends VoiceHandler {
  constructor (client, key) {
    super(client)
    this._key = key
    this._pushed = false
    this._keydown_handler = () => this._pushed = true
    this._keyup_handler = () => {
      this._stopOutbound()
      this._pushed = false
    }
    keyboardjs.bind(this._key, this._keydown_handler, this._keyup_handler)
  }

  _write (data, _, callback) {
    if (this._pushed) {
      this._getOrCreateOutbound().write(data, callback)
    } else {
      callback()
    }
  }

  _final (callback) {
    super._final(e => {
      keyboardjs.unbind(this._key, this._keydown_handler, this._keyup_handler)
      callback(e)
    })
  }
}

export class VADVoiceHandler extends VoiceHandler {
  constructor (client, level) {
    super(client)
    const self = this
    this._vad = vad(audioContext, theUserMedia, {
      onVoiceStart () {
        console.log('vad: start')
        self._active = true
      },
      onVoiceStop () {
        console.log('vad: stop')
        self._stopOutbound()
        self._active = false
      },
      onUpdate (val) {
        self._level = val
        self.emit('level', val)
      },
      noiseCaptureDuration: 0,
      minNoiseLevel: level,
      maxNoiseLevel: level
    })
    // Need to keep a backlog of the last ~150ms (dependent on sample rate)
    // because VAD will activate with ~125ms delay
    this._backlog = []
    this._backlogLength = 0
    this._backlogLengthMin = 1024 * 6 * 4 // vadBufferLen * (vadDelay + 1) * bytesPerSample
  }

  _write (data, _, callback) {
    if (this._active) {
      if (this._backlog.length > 0) {
        for (let oldData of this._backlog) {
          this._getOrCreateOutbound().write(oldData)
        }
        this._backlog = []
        this._backlogLength = 0
      }
      this._getOrCreateOutbound().write(data, callback)
    } else {
      // Make sure we always keep the backlog filled if we're not (yet) talking
      this._backlog.push(data)
      this._backlogLength += data.length
      // Check if we can discard the oldest element without becoming too short
      if (this._backlogLength - this._backlog[0].length > this._backlogLengthMin) {
        this._backlogLength -= this._backlog.shift().length
      }
      callback()
    }
  }

  _final (callback) {
    super._final(e => {
      this._vad.destroy()
      callback(e)
    })
  }
}

var theUserMedia = null

export function initVoice (onData, onUserMediaError) {
  getUserMedia({ audio: true }, (err, userMedia) => {
    if (err) {
      onUserMediaError(err)
    } else {
      theUserMedia = userMedia
      var micStream = new MicrophoneStream(userMedia, { objectMode: true, bufferSize: 1024 })
      micStream.on('data', data => {
        onData(Buffer.from(data.getChannelData(0).buffer))
      })
    }
  })
}
