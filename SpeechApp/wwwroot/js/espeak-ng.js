/**
 * eSpeak-NG WASM Integration
 *
 * This module provides browser-side integration with eSpeak-NG WebAssembly.
 * eSpeak-NG is a compact, multi-language speech synthesizer.
 *
 * Library: meSpeak.js / text2wav (espeak compiled to JS/WASM)
 * Documentation: https://www.masswerk.at/mespeak/
 */

// Import eSpeak library (loaded via CDN or script tag)
let espeakLib = null;

window.espeakNG = {
    _isInitialized: false,

    /**
     * Initialize eSpeak-NG
     */
    async initialize() {
        if (this._isInitialized) {
            return true;
        }

        try {
            // Wait for meSpeak library to load (with retry)
            let retries = 0;
            while (typeof window.meSpeak === 'undefined' && retries < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                retries++;
            }

            if (typeof window.meSpeak !== 'undefined' && window.meSpeak !== null) {
                espeakLib = window.meSpeak;

                // Wait for voices to load
                await new Promise(resolve => setTimeout(resolve, 500));

                // Only set _isInitialized if espeakLib was successfully set
                this._isInitialized = true;
                return true;
            } else {
                console.error('eSpeak-NG initialization failed: Web Speech API not available');
                return false;
            }
        } catch (error) {
            console.error('eSpeak-NG initialization error:', error);
            return false;
        }
    },

    /**
     * Check if eSpeak is ready
     */
    async isReady() {
        if (this._isInitialized) return true;
        return await this.initialize();
    },

    /**
     * Synthesize speech from text
     * @param {string} text - Text to synthesize
     * @param {string} voice - Voice ID (language code)
     * @param {number} speed - Speech speed (default 175 wpm)
     * @param {number} pitch - Speech pitch (default 50, range 0-99)
     * @returns {Promise<string>} Base64 encoded WAV audio
     */
    async synthesize(text, voice = 'en', speed = 175, pitch = 50) {
        if (!this._isInitialized) {
            await this.initialize();
        }

        try {
            // Check if eSpeak library is available
            if (!espeakLib || typeof espeakLib.getWav !== 'function') {
                console.warn('meSpeak library not available, using fallback');
                return this.generateTestBeep(1.0);
            }

            // Parse voice to extract language/variant
            // Voice format can be: "en", "en-us", "en-gb", etc.
            let voiceOptions = {
                speed: speed,
                pitch: pitch,
                wordgap: 0
            };

            // If voice includes variant (e.g., "en-us"), set it
            if (voice.includes('-')) {
                const parts = voice.split('-');
                voiceOptions.variant = parts[1];
            }

            // Use meSpeak.getWav() to generate WAV file instead of playing
            const wavData = espeakLib.getWav(text, voiceOptions);

            if (!wavData) {
                console.error('meSpeak.getWav returned null');
                return this.generateTestBeep(1.0);
            }

            // Convert Uint8Array to base64
            return this.arrayBufferToBase64(wavData.buffer);

        } catch (error) {
            console.error('eSpeak synthesis error:', error);
            throw new Error(`Synthesis failed: ${error.message}`);
        }
    },

    /**
     * Generate a silent WAV file
     */
    generateSilentWav(durationSeconds) {
        const sampleRate = 22050;
        const numSamples = Math.floor(sampleRate * durationSeconds);

        // WAV header
        const header = new ArrayBuffer(44);
        const view = new DataView(header);

        // "RIFF" chunk descriptor
        view.setUint32(0, 0x46464952, true); // "RIFF"
        view.setUint32(4, 36 + numSamples * 2, true); // File size - 8
        view.setUint32(8, 0x45564157, true); // "WAVE"

        // "fmt " sub-chunk
        view.setUint32(12, 0x20746d66, true); // "fmt "
        view.setUint32(16, 16, true); // Subchunk size
        view.setUint16(20, 1, true); // Audio format (PCM)
        view.setUint16(22, 1, true); // Num channels (mono)
        view.setUint32(24, sampleRate, true); // Sample rate
        view.setUint32(28, sampleRate * 2, true); // Byte rate
        view.setUint16(32, 2, true); // Block align
        view.setUint16(34, 16, true); // Bits per sample

        // "data" sub-chunk
        view.setUint32(36, 0x61746164, true); // "data"
        view.setUint32(40, numSamples * 2, true); // Subchunk size

        // Generate silent audio
        const audioBuffer = new ArrayBuffer(44 + numSamples * 2);
        const audioView = new DataView(audioBuffer);

        // Copy header
        for (let i = 0; i < 44; i++) {
            audioView.setUint8(i, view.getUint8(i));
        }

        // Silence (all zeros)
        for (let i = 0; i < numSamples; i++) {
            audioView.setInt16(44 + i * 2, 0, true);
        }

        return this.arrayBufferToBase64(audioBuffer);
    },

    /**
     * Get available voices
     * @returns {Promise<Array>} List of voice objects
     */
    async getVoices() {
        // Check if library is loaded and has voice data
        if (espeakLib && typeof espeakLib.getVoices === 'function') {
            try {
                const voices = espeakLib.getVoices();
                return voices.map(v => ({
                    id: v.id || v.name,
                    name: v.name,
                    language: v.lang || v.language
                }));
            } catch (error) {
                console.warn('Error getting eSpeak voices from library:', error);
            }
        }

        // Fallback: Return default voice list
        // eSpeak-NG supports 127+ languages
        return [
            { id: 'en', name: 'English', language: 'English' },
            { id: 'en-us', name: 'English (US)', language: 'English (US)' },
            { id: 'en-gb', name: 'English (UK)', language: 'English (UK)' },
            { id: 'es', name: 'Spanish', language: 'Spanish' },
            { id: 'fr', name: 'French', language: 'French' },
            { id: 'de', name: 'German', language: 'German' },
            { id: 'it', name: 'Italian', language: 'Italian' },
            { id: 'pt', name: 'Portuguese', language: 'Portuguese' },
            { id: 'ru', name: 'Russian', language: 'Russian' },
            { id: 'zh', name: 'Chinese (Mandarin)', language: 'Chinese' },
            { id: 'ja', name: 'Japanese', language: 'Japanese' },
            { id: 'ko', name: 'Korean', language: 'Korean' },
            { id: 'ar', name: 'Arabic', language: 'Arabic' }
        ];
    },

    /**
     * Convert ArrayBuffer to Base64
     */
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    /**
     * Generate test beep audio (for placeholder - makes it obvious this is not real TTS)
     */
    generateTestBeep(durationSeconds) {
        const sampleRate = 22050;
        const numSamples = Math.floor(sampleRate * durationSeconds);
        const frequency = 440; // A4 note

        // WAV header
        const header = new ArrayBuffer(44);
        const view = new DataView(header);

        // "RIFF" chunk descriptor
        view.setUint32(0, 0x46464952, true); // "RIFF"
        view.setUint32(4, 36 + numSamples * 2, true); // File size - 8
        view.setUint32(8, 0x45564157, true); // "WAVE"

        // "fmt " sub-chunk
        view.setUint32(12, 0x20746d66, true); // "fmt "
        view.setUint32(16, 16, true); // Subchunk size
        view.setUint16(20, 1, true); // Audio format (PCM)
        view.setUint16(22, 1, true); // Num channels (mono)
        view.setUint32(24, sampleRate, true); // Sample rate
        view.setUint32(28, sampleRate * 2, true); // Byte rate
        view.setUint16(32, 2, true); // Block align
        view.setUint16(34, 16, true); // Bits per sample

        // "data" sub-chunk
        view.setUint32(36, 0x61746164, true); // "data"
        view.setUint32(40, numSamples * 2, true); // Subchunk size

        // Generate beep tone
        const audioBuffer = new ArrayBuffer(44 + numSamples * 2);
        const audioView = new DataView(audioBuffer);

        // Copy header
        for (let i = 0; i < 44; i++) {
            audioView.setUint8(i, view.getUint8(i));
        }

        // Generate sine wave beep
        const amplitude = 5000; // Lower amplitude for gentler beep
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
            audioView.setInt16(44 + i * 2, sample, true);
        }

        return this.arrayBufferToBase64(audioBuffer);
    }
};

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    await window.espeakNG.initialize();
});
