/**
 * Piper TTS WASM Integration
 *
 * This module provides browser-side integration with Piper TTS WebAssembly.
 * Piper is a fast, local neural text-to-speech system.
 *
 * Library: @mintplex-labs/piper-tts-web
 * Documentation: https://github.com/Mintplex-Labs/piper-tts-web
 */

// Import Piper TTS library (loaded via CDN in index.html)
let piperLib = null;

window.piperTTS = {
    isInitialized: false,
    dbName: 'PiperTTSDB',
    dbVersion: 1,
    db: null,

    /**
     * Initialize Piper TTS
     */
    async init() {
        if (this.isInitialized) return true;

        try {
            // Open IndexedDB for model storage
            this.db = await this.openDatabase();

            // Wait for Piper library to be available (with retry)
            let retries = 0;
            while (!window.piperTTSLib && retries < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                retries++;
            }

            if (typeof window.piperTTSLib !== 'undefined') {
                piperLib = window.piperTTSLib;

                // Verify required methods exist
                if (typeof piperLib.download !== 'function' || typeof piperLib.predict !== 'function') {
                    console.error('Piper TTS library missing required methods');
                    return false;
                }
            } else {
                console.error('Piper TTS library not loaded');
                return false;
            }

            this.isInitialized = true;
            return true;
        } catch (error) {
            console.error('Failed to initialize Piper TTS:', error.message);
            return false;
        }
    },

    /**
     * Open IndexedDB for storing voice models
     */
    async openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object store for models
                if (!db.objectStoreNames.contains('models')) {
                    const store = db.createObjectStore('models', { keyPath: 'id' });
                    store.createIndex('language', 'language', { unique: false });
                    store.createIndex('downloadedDate', 'downloadedDate', { unique: false });
                }
            };
        });
    },

    /**
     * Synthesize speech from text
     * @param {string} text - Text to synthesize
     * @param {string} modelId - Model ID to use
     * @returns {Promise<string>} Base64 encoded WAV audio
     */
    async synthesize(text, modelId) {
        if (!this.isInitialized) {
            await this.init();
        }

        try {
            // Check if Piper library is available
            if (!piperLib) {
                console.warn('Piper library not available, using fallback');
                return this.generateTestBeep(1.0);
            }

            // Check if model is downloaded
            const downloadedModels = await this.getDownloadedModels();

            if (!downloadedModels.includes(modelId)) {
                throw new Error(`Model "${modelId}" not downloaded. Please download it first from the Offline Mode page.`);
            }

            // Use Piper TTS library to synthesize
            const wavBlob = await piperLib.predict({
                text: text,
                voiceId: modelId
            });

            // Convert Blob to ArrayBuffer then to Base64
            const arrayBuffer = await wavBlob.arrayBuffer();
            const base64 = this.arrayBufferToBase64(arrayBuffer);

            return base64;

        } catch (error) {
            console.error('Piper synthesis error:', error);
            throw new Error(`Synthesis failed: ${error.message}`);
        }
    },

    /**
     * Download a voice model
     * @param {string} modelId - Model ID to download
     * @param {DotNet.DotNetObjectReference} progressCallback - Progress callback
     * @returns {Promise<boolean>} Success status
     */
    async downloadModel(modelId, progressCallback) {
        try {
            // Ensure initialized
            if (!this.isInitialized) {
                await this.init();
            }

            if (!piperLib || typeof piperLib.download !== 'function') {
                throw new Error('Piper TTS library not available');
            }

            // Get available voices to find the correct model ID
            let actualModelId = modelId;
            try {
                const availableVoices = typeof piperLib.voices === 'function'
                    ? await piperLib.voices()
                    : piperLib.voices;

                if (availableVoices && availableVoices.length > 0) {
                    const voiceMatch = availableVoices.find(v =>
                        v.key === modelId || v.name === modelId || v.id === modelId
                    );
                    if (voiceMatch) {
                        actualModelId = voiceMatch.key || voiceMatch.id || modelId;
                    }
                }
            } catch (voicesError) {
                // Continue with provided modelId if voice lookup fails
            }

            // Download with progress tracking
            await piperLib.download(actualModelId, (progress) => {
                const percentage = progress.total > 0
                    ? Math.round((progress.loaded * 100) / progress.total)
                    : 0;

                if (progressCallback) {
                    try {
                        progressCallback.invokeMethodAsync('Invoke', percentage);
                    } catch (callbackError) {
                        // Silently ignore callback errors
                    }
                }
            });

            // Store metadata in our IndexedDB
            await this.storeModel(actualModelId, new ArrayBuffer(0));

            return true;
        } catch (error) {
            console.error('Piper download failed:', error.message);
            return false;
        }
    },

    /**
     * Remove a downloaded model
     * @param {string} modelId - Model ID to remove
     * @returns {Promise<boolean>} Success status
     */
    async removeModel(modelId) {
        try {
            if (piperLib) {
                // Remove from Piper's storage
                await piperLib.remove(modelId);
            }

            // Also remove metadata from IndexedDB
            if (this.db) {
                const transaction = this.db.transaction(['models'], 'readwrite');
                const store = transaction.objectStore('models');
                await this.promisifyRequest(store.delete(modelId));
            }

            return true;
        } catch (error) {
            console.error('Piper model removal error:', error);
            return false;
        }
    },

    /**
     * Get list of downloaded models
     * @returns {Promise<string[]>} Array of model IDs
     */
    async getDownloadedModels() {
        try {
            if (!piperLib) {
                // Fallback to IndexedDB if library not loaded
                if (!this.db) {
                    await this.init();
                }

                const transaction = this.db.transaction(['models'], 'readonly');
                const store = transaction.objectStore('models');
                const request = store.getAllKeys();

                const keys = await this.promisifyRequest(request);
                return keys || [];
            }

            // Use Piper library's stored() method
            const storedModels = await piperLib.stored();

            // Ensure we always return an array of strings
            if (!storedModels || !Array.isArray(storedModels)) {
                return [];
            }

            // If array contains objects, extract the IDs
            if (storedModels.length > 0 && typeof storedModels[0] === 'object') {
                return storedModels.map(m => m.key || m.id || m.name || String(m));
            }

            return storedModels;
        } catch (error) {
            console.error('Error getting downloaded models:', error.message);
            return [];
        }
    },

    /**
     * Store model data in IndexedDB
     *
     * Models are stored permanently with no expiration or TTL.
     * They persist indefinitely until:
     * 1. Manually deleted by user via removeModel()
     * 2. Browser storage quota exceeded (browser handles this)
     */
    async storeModel(modelId, modelData) {
        const transaction = this.db.transaction(['models'], 'readwrite');
        const store = transaction.objectStore('models');

        const modelEntry = {
            id: modelId,
            data: modelData,
            downloadedDate: new Date().toISOString()
            // Note: No expirationDate or TTL - models persist indefinitely
        };

        await this.promisifyRequest(store.put(modelEntry));
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
    },

    /**
     * Get all available voices from the Piper library
     * @returns {Promise<Array>} Array of voice metadata objects
     */
    async getAvailableVoices() {
        try {
            if (!this.isInitialized) {
                await this.init();
            }

            if (!piperLib || typeof piperLib.voices !== 'function') {
                console.warn('⚠️ Piper library or voices method not available');
                return [];
            }

            const voices = await piperLib.voices();

            // Log first voice to debug size issue
            if (voices.length > 0) {
                console.log('Voice structure sample:', JSON.stringify(voices[0], null, 2));
            }

            // Transform to our format
            return voices.map(v => {
                // Extract language info - the language property is an object with code, family, region, name_native, name_english
                let languageName = 'Unknown';
                let languageCode = 'unknown';

                if (v.language) {
                    if (typeof v.language === 'string') {
                        languageName = v.language;
                        languageCode = v.language;
                    } else if (typeof v.language === 'object') {
                        languageName = v.language.name_english || v.language.name_native || v.language.family || 'Unknown';
                        languageCode = v.language.code || v.language.family || 'unknown';
                    }
                }

                // Extract file size - Piper library provides size in bytes as a number
                const sizeBytes = typeof v.size === 'number' ? v.size : (parseInt(v.size) || 0);

                return {
                    id: v.key,
                    name: v.name || v.key,
                    language: languageName,
                    languageCode: languageCode,
                    gender: 'NEUTRAL', // Piper doesn't provide gender info
                    quality: this.extractQuality(v.key),
                    sizeBytes: sizeBytes
                };
            });
        } catch (error) {
            console.error('Error loading Piper voices:', error.message);
            return [];
        }
    },

    /**
     * Extract quality level from voice key
     */
    extractQuality(key) {
        if (key.endsWith('-x_low')) return 'Very Low';
        if (key.endsWith('-low')) return 'Low';
        if (key.endsWith('-medium')) return 'Medium';
        if (key.endsWith('-high')) return 'High';
        return 'Medium';
    },

    /**
     * Promisify IndexedDB request
     */
    promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
};

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => {
    window.piperTTS.init();
});
