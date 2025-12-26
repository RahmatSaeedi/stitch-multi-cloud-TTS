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
            console.log('🔧 Initializing Piper TTS...');

            // Open IndexedDB for model storage
            this.db = await this.openDatabase();
            console.log('✅ IndexedDB opened');

            // Wait for Piper library to be available (with retry)
            let retries = 0;
            while (!window.piperTTSLib && retries < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                retries++;
            }

            if (typeof window.piperTTSLib !== 'undefined') {
                piperLib = window.piperTTSLib;
                console.log('✅ Piper library loaded:', piperLib);
                console.log('Available Piper methods:', Object.keys(piperLib));

                // Check if library has required methods
                if (typeof piperLib.download === 'function') {
                    console.log('✅ Piper download method available');
                } else {
                    console.warn('⚠️ Piper download method not found');
                }

                if (typeof piperLib.predict === 'function') {
                    console.log('✅ Piper predict method available');
                } else {
                    console.warn('⚠️ Piper predict method not found');
                }
            } else {
                console.error('❌ Piper TTS library not loaded from CDN');
                console.log('Please check network connectivity and CDN availability');
            }

            this.isInitialized = true;
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Piper TTS:', error);
            console.error('Stack:', error.stack);
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
                console.log('Piper not initialized, initializing now...');
                await this.init();
            }

            console.log('🔽 Download requested for model:', modelId);
            console.log('Piper library loaded:', !!piperLib);
            console.log('Piper library type:', typeof piperLib);
            console.log('Piper library has download:', piperLib && typeof piperLib.download);

            if (!piperLib) {
                const errorMsg = 'Piper TTS library not loaded. Check if CDN is accessible and library initialized.';
                console.error('❌', errorMsg);
                throw new Error(errorMsg);
            }

            if (typeof piperLib.download !== 'function') {
                const errorMsg = 'Piper library loaded but download method not available';
                console.error('❌', errorMsg);
                console.log('Available methods:', Object.keys(piperLib));
                throw new Error(errorMsg);
            }

            // Get available voices from library
            let availableVoices = [];
            try {
                // Check if voices is a property or function
                if (typeof piperLib.voices === 'function') {
                    console.log('Calling piperLib.voices()...');
                    availableVoices = await piperLib.voices();
                } else if (Array.isArray(piperLib.voices)) {
                    console.log('Using piperLib.voices array...');
                    availableVoices = piperLib.voices;
                } else {
                    console.log('piperLib.voices type:', typeof piperLib.voices);
                }

                if (availableVoices && availableVoices.length > 0) {
                    console.log('📋 Available voices from library:', availableVoices.slice(0, 5)); // Show first 5
                    console.log('Total voices:', availableVoices.length);
                } else {
                    console.warn('⚠️ No voices returned from library');
                }
            } catch (voicesError) {
                console.warn('⚠️ Error getting voices:', voicesError);
            }

            // Check if the modelId is in the available voices
            let actualModelId = modelId;
            if (availableVoices && availableVoices.length > 0) {
                const voiceMatch = availableVoices.find(v =>
                    v.key === modelId ||
                    v.name === modelId ||
                    v.id === modelId
                );

                if (voiceMatch) {
                    console.log('✅ Found matching voice:', voiceMatch);
                    actualModelId = voiceMatch.key || voiceMatch.id || modelId;
                } else {
                    console.warn('⚠️ Model ID not found in library voices');
                    console.log('Requested:', modelId);
                    console.log('Available keys:', availableVoices.slice(0, 10).map(v => v.key || v.id || v.name));
                }
            }

            console.log('📥 Starting download for model:', actualModelId);

            // Use Piper library's download with progress tracking
            // The download function will throw on error
            try {
                await piperLib.download(actualModelId, (progress) => {
                    // Progress object has loaded and total properties
                    const percentage = progress.total > 0
                        ? Math.round((progress.loaded * 100) / progress.total)
                        : 0;

                    console.log(`Download progress: ${percentage}%`);

                    if (progressCallback) {
                        try {
                            progressCallback.invokeMethodAsync('Invoke', percentage);
                        } catch (callbackError) {
                            console.warn('Progress callback error:', callbackError);
                        }
                    }
                });

                console.log('✅ Download completed, storing metadata');

                // Store metadata in our IndexedDB
                await this.storeModel(actualModelId, new ArrayBuffer(0));

                console.log('✅ Model downloaded successfully:', actualModelId);
                return true;
            } catch (downloadError) {
                console.error('❌ Download failed:', downloadError);
                console.error('Download error message:', downloadError.message);
                console.error('Download error stack:', downloadError.stack);
                throw downloadError; // Re-throw to be caught by outer try-catch
            }
        } catch (error) {
            console.error('❌ Piper download error:', error);
            console.error('Error stack:', error.stack);
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
            console.log('📋 Getting downloaded models...');

            if (!piperLib) {
                console.log('Piper library not loaded, using IndexedDB fallback');
                // Fallback to IndexedDB if library not loaded
                if (!this.db) {
                    await this.init();
                }

                const transaction = this.db.transaction(['models'], 'readonly');
                const store = transaction.objectStore('models');
                const request = store.getAllKeys();

                const keys = await this.promisifyRequest(request);
                console.log('Downloaded models from IndexedDB:', keys);
                return keys || [];
            }

            // Use Piper library's stored() method to get actually downloaded models
            console.log('Calling piperLib.stored()...');
            const storedModels = await piperLib.stored();
            console.log('Stored models from Piper library:', storedModels);
            console.log('Type:', typeof storedModels);
            console.log('Is array:', Array.isArray(storedModels));

            // Ensure we always return an array of strings
            if (!storedModels) {
                console.warn('⚠️ piperLib.stored() returned null/undefined');
                return [];
            }

            if (!Array.isArray(storedModels)) {
                console.warn('⚠️ piperLib.stored() did not return array:', storedModels);
                return [];
            }

            // If array contains objects, extract the IDs
            if (storedModels.length > 0 && typeof storedModels[0] === 'object') {
                console.log('Converting objects to string IDs');
                const ids = storedModels.map(m => m.key || m.id || m.name || String(m));
                console.log('Model IDs:', ids);
                return ids;
            }

            console.log('Returning model IDs:', storedModels);
            return storedModels;
        } catch (error) {
            console.error('❌ Error getting downloaded models:', error);
            console.error('Stack:', error.stack);
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
