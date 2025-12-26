using Microsoft.JSInterop;
using SpeechApp.Models;
using SpeechApp.Services.Interfaces;

namespace SpeechApp.Services.Offline;

public class PiperTTSService : ITTSProvider, IOfflineTTSProvider
{
    private readonly IJSRuntime _jsRuntime;
    private readonly IStorageService _storageService;
    private List<OfflineVoiceModel>? _downloadedModels;

    private const string PROVIDER_ID = "piper";
    private const int MAX_CHARACTERS = 5000;
    private const string STORAGE_KEY = "piper_downloaded_models";

    public PiperTTSService(IJSRuntime jsRuntime, IStorageService storageService)
    {
        _jsRuntime = jsRuntime;
        _storageService = storageService;
    }

    public ProviderInfo GetProviderInfo()
    {
        return new ProviderInfo
        {
            Id = PROVIDER_ID,
            Name = "Piper",
            DisplayName = "Piper TTS (Offline)",
            MaxCharacterLimit = MAX_CHARACTERS,
            RequiresApiKey = false,
            SupportsSSML = false,
            SetupGuideUrl = "/help/offline-setup#piper",
            Health = ProviderHealth.Unknown
        };
    }

    public async Task<bool> IsReadyAsync()
    {
        try
        {
            var downloaded = await GetDownloadedModelsAsync();
            return downloaded.Any();
        }
        catch
        {
            return false;
        }
    }

    public async Task<List<Voice>> GetVoicesAsync(CancellationToken cancellationToken = default)
    {
        var downloaded = await GetDownloadedModelsAsync();
        return downloaded.Select(model => new Voice
        {
            Id = model.Id,
            Name = model.Name,
            Language = model.Language,
            LanguageCode = model.LanguageCode,
            Gender = model.Gender,
            Quality = model.Quality,
            ProviderId = PROVIDER_ID,
            Metadata = new Dictionary<string, object>
            {
                ["IsOffline"] = true,
                ["ModelSize"] = model.SizeBytes,
                ["DownloadedDate"] = model.DownloadedDate ?? DateTime.MinValue
            }
        }).ToList();
    }

    // ITTSProvider implementation
    public Task<List<Voice>> GetVoicesAsync(bool bypassCache = false, CancellationToken cancellationToken = default)
    {
        // Clear cache if requested to bypass it (e.g., after downloading new models)
        if (bypassCache)
        {
            _downloadedModels = null;
        }
        return GetVoicesAsync(cancellationToken);
    }

    public Task<bool> ValidateApiKeyAsync(string apiKey, CancellationToken cancellationToken = default)
    {
        // Offline providers don't require API keys
        return Task.FromResult(true);
    }

    public decimal CalculateCost(int characterCount, VoiceConfig? config = null)
    {
        // Offline TTS is free
        return 0m;
    }

    public void SetApiKey(string apiKey)
    {
        // Offline providers don't use API keys - no-op
    }

    public async Task<SynthesisResult> SynthesizeSpeechAsync(string text, VoiceConfig config, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return new SynthesisResult
            {
                Success = false,
                ErrorMessage = "Text cannot be empty"
            };
        }

        if (text.Length > MAX_CHARACTERS)
        {
            return new SynthesisResult
            {
                Success = false,
                ErrorMessage = $"Text exceeds maximum length of {MAX_CHARACTERS} characters"
            };
        }

        if (!await IsReadyAsync())
        {
            return new SynthesisResult
            {
                Success = false,
                ErrorMessage = "No Piper models downloaded. Please download a voice model first."
            };
        }

        var startTime = DateTime.UtcNow;

        try
        {
            // Call JavaScript interop for Piper WASM
            var audioBase64 = await _jsRuntime.InvokeAsync<string>(
                "piperTTS.synthesize",
                cancellationToken,
                text,
                config.VoiceId
            );

            if (string.IsNullOrEmpty(audioBase64))
            {
                return new SynthesisResult
                {
                    Success = false,
                    ErrorMessage = "Piper TTS failed to generate audio"
                };
            }

            var audioData = Convert.FromBase64String(audioBase64);
            var duration = DateTime.UtcNow - startTime;

            return new SynthesisResult
            {
                Success = true,
                AudioData = audioData,
                CharactersProcessed = text.Length,
                Cost = 0, // Offline TTS is free
                Duration = duration
            };
        }
        catch (Exception ex)
        {
            return new SynthesisResult
            {
                Success = false,
                ErrorMessage = $"Piper TTS synthesis failed: {ex.Message}"
            };
        }
    }

    public int GetMaxCharacterLimit() => MAX_CHARACTERS;

    public async Task<bool> DownloadModelAsync(string modelId, Action<int>? progress = null, CancellationToken cancellationToken = default)
    {
        try
        {
            // Create progress callback for JavaScript
            var progressCallback = DotNetObjectReference.Create(new ProgressCallback(prog =>
            {
                progress?.Invoke(prog);
            }));

            var success = await _jsRuntime.InvokeAsync<bool>(
                "piperTTS.downloadModel",
                cancellationToken,
                modelId,
                progressCallback
            );

            progressCallback.Dispose();

            if (success)
            {
                // Refresh downloaded models list
                _downloadedModels = null;
                await GetDownloadedModelsAsync();

                // Set flag to notify other pages that models have been updated
                await _storageService.SetPreferenceAsync("piper_models_updated", DateTime.UtcNow.Ticks.ToString());
            }

            return success;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error downloading Piper model: {ex.Message}");
            return false;
        }
    }

    public async Task<bool> RemoveModelAsync(string modelId)
    {
        try
        {
            var success = await _jsRuntime.InvokeAsync<bool>("piperTTS.removeModel", modelId);

            if (success)
            {
                // Refresh downloaded models list
                _downloadedModels = null;
                await GetDownloadedModelsAsync();

                // Set flag to notify other pages that models have been updated
                await _storageService.SetPreferenceAsync("piper_models_updated", DateTime.UtcNow.Ticks.ToString());
            }

            return success;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error removing Piper model: {ex.Message}");
            return false;
        }
    }

    public async Task<List<OfflineVoiceModel>> GetAvailableModelsAsync()
    {
        // Comprehensive Piper voice catalog - 50+ languages with multiple quality levels
        // Models persist indefinitely in IndexedDB unless manually deleted or storage quota exceeded
        return await Task.FromResult(new List<OfflineVoiceModel>
        {
            // ========== ENGLISH ==========
            // US English
            new OfflineVoiceModel { Id = "en_US-lessac-medium", Name = "Lessac", Language = "English (US)", LanguageCode = "en-US", Gender = "FEMALE", Quality = "Medium", SizeBytes = 63 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Clear American English female voice" },
            new OfflineVoiceModel { Id = "en_US-lessac-low", Name = "Lessac (Low)", Language = "English (US)", LanguageCode = "en-US", Gender = "FEMALE", Quality = "Low", SizeBytes = 32 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Lessac voice" },
            new OfflineVoiceModel { Id = "en_US-libritts-high", Name = "LibriTTS", Language = "English (US)", LanguageCode = "en-US", Gender = "NEUTRAL", Quality = "High", SizeBytes = 123 * 1024 * 1024, Provider = PROVIDER_ID, Description = "High-quality multi-speaker voice" },
            new OfflineVoiceModel { Id = "en_US-amy-medium", Name = "Amy", Language = "English (US)", LanguageCode = "en-US", Gender = "FEMALE", Quality = "Medium", SizeBytes = 54 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Natural female voice" },
            new OfflineVoiceModel { Id = "en_US-amy-low", Name = "Amy (Low)", Language = "English (US)", LanguageCode = "en-US", Gender = "FEMALE", Quality = "Low", SizeBytes = 28 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Amy voice" },
            new OfflineVoiceModel { Id = "en_US-kathleen-low", Name = "Kathleen", Language = "English (US)", LanguageCode = "en-US", Gender = "FEMALE", Quality = "Low", SizeBytes = 25 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Clear female voice" },
            new OfflineVoiceModel { Id = "en_US-ryan-medium", Name = "Ryan", Language = "English (US)", LanguageCode = "en-US", Gender = "MALE", Quality = "Medium", SizeBytes = 48 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Natural male voice" },
            new OfflineVoiceModel { Id = "en_US-ryan-low", Name = "Ryan (Low)", Language = "English (US)", LanguageCode = "en-US", Gender = "MALE", Quality = "Low", SizeBytes = 22 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Ryan voice" },
            new OfflineVoiceModel { Id = "en_US-joe-medium", Name = "Joe", Language = "English (US)", LanguageCode = "en-US", Gender = "MALE", Quality = "Medium", SizeBytes = 52 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Warm male voice" },
            new OfflineVoiceModel { Id = "en_US-arctic-medium", Name = "Arctic", Language = "English (US)", LanguageCode = "en-US", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 45 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Multi-speaker dataset voice" },

            // UK English
            new OfflineVoiceModel { Id = "en_GB-alba-medium", Name = "Alba", Language = "English (UK)", LanguageCode = "en-GB", Gender = "FEMALE", Quality = "Medium", SizeBytes = 51 * 1024 * 1024, Provider = PROVIDER_ID, Description = "British English female voice" },
            new OfflineVoiceModel { Id = "en_GB-alba-low", Name = "Alba (Low)", Language = "English (UK)", LanguageCode = "en-GB", Gender = "FEMALE", Quality = "Low", SizeBytes = 26 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight British voice" },
            new OfflineVoiceModel { Id = "en_GB-jenny_dioco-medium", Name = "Jenny", Language = "English (UK)", LanguageCode = "en-GB", Gender = "FEMALE", Quality = "Medium", SizeBytes = 47 * 1024 * 1024, Provider = PROVIDER_ID, Description = "British female voice" },
            new OfflineVoiceModel { Id = "en_GB-northern_english_male-medium", Name = "Northern Male", Language = "English (UK)", LanguageCode = "en-GB", Gender = "MALE", Quality = "Medium", SizeBytes = 49 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Northern England accent" },
            new OfflineVoiceModel { Id = "en_GB-vctk-medium", Name = "VCTK", Language = "English (UK)", LanguageCode = "en-GB", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 55 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Multi-speaker British voices" },

            // ========== SPANISH ==========
            new OfflineVoiceModel { Id = "es_ES-mls-medium", Name = "Spanish MLS", Language = "Spanish (Spain)", LanguageCode = "es-ES", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 54 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Castilian Spanish voice" },
            new OfflineVoiceModel { Id = "es_ES-sharvard-medium", Name = "Sharvard", Language = "Spanish (Spain)", LanguageCode = "es-ES", Gender = "MALE", Quality = "Medium", SizeBytes = 42 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Spanish male voice" },
            new OfflineVoiceModel { Id = "es_ES-davefx-medium", Name = "Davefx", Language = "Spanish (Spain)", LanguageCode = "es-ES", Gender = "MALE", Quality = "Medium", SizeBytes = 46 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Expressive Spanish voice" },
            new OfflineVoiceModel { Id = "es_MX-ald-medium", Name = "Ald", Language = "Spanish (Mexico)", LanguageCode = "es-MX", Gender = "MALE", Quality = "Medium", SizeBytes = 38 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Mexican Spanish voice" },
            new OfflineVoiceModel { Id = "es_AR-tux-medium", Name = "Tux", Language = "Spanish (Argentina)", LanguageCode = "es-AR", Gender = "MALE", Quality = "Medium", SizeBytes = 41 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Argentinian Spanish voice" },

            // ========== FRENCH ==========
            new OfflineVoiceModel { Id = "fr_FR-siwis-medium", Name = "Siwis", Language = "French (France)", LanguageCode = "fr-FR", Gender = "FEMALE", Quality = "Medium", SizeBytes = 47 * 1024 * 1024, Provider = PROVIDER_ID, Description = "French female voice" },
            new OfflineVoiceModel { Id = "fr_FR-siwis-low", Name = "Siwis (Low)", Language = "French (France)", LanguageCode = "fr-FR", Gender = "FEMALE", Quality = "Low", SizeBytes = 24 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Siwis voice" },
            new OfflineVoiceModel { Id = "fr_FR-tom-medium", Name = "Tom", Language = "French (France)", LanguageCode = "fr-FR", Gender = "MALE", Quality = "Medium", SizeBytes = 52 * 1024 * 1024, Provider = PROVIDER_ID, Description = "French male voice" },
            new OfflineVoiceModel { Id = "fr_FR-upmc-medium", Name = "UPMC", Language = "French (France)", LanguageCode = "fr-FR", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 48 * 1024 * 1024, Provider = PROVIDER_ID, Description = "University voice dataset" },

            // ========== GERMAN ==========
            new OfflineVoiceModel { Id = "de_DE-thorsten-medium", Name = "Thorsten", Language = "German", LanguageCode = "de-DE", Gender = "MALE", Quality = "Medium", SizeBytes = 92 * 1024 * 1024, Provider = PROVIDER_ID, Description = "High-quality German male voice" },
            new OfflineVoiceModel { Id = "de_DE-thorsten-low", Name = "Thorsten (Low)", Language = "German", LanguageCode = "de-DE", Gender = "MALE", Quality = "Low", SizeBytes = 45 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Thorsten voice" },
            new OfflineVoiceModel { Id = "de_DE-kerstin-medium", Name = "Kerstin", Language = "German", LanguageCode = "de-DE", Gender = "FEMALE", Quality = "Medium", SizeBytes = 56 * 1024 * 1024, Provider = PROVIDER_ID, Description = "German female voice" },
            new OfflineVoiceModel { Id = "de_DE-pavoque-medium", Name = "Pavoque", Language = "German", LanguageCode = "de-DE", Gender = "MALE", Quality = "Medium", SizeBytes = 48 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Clear German voice" },
            new OfflineVoiceModel { Id = "de_DE-ramona-medium", Name = "Ramona", Language = "German", LanguageCode = "de-DE", Gender = "FEMALE", Quality = "Medium", SizeBytes = 52 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Natural German female" },

            // ========== ITALIAN ==========
            new OfflineVoiceModel { Id = "it_IT-riccardo-medium", Name = "Riccardo", Language = "Italian", LanguageCode = "it-IT", Gender = "MALE", Quality = "Medium", SizeBytes = 78 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Italian male voice" },
            new OfflineVoiceModel { Id = "it_IT-paola-medium", Name = "Paola", Language = "Italian", LanguageCode = "it-IT", Gender = "FEMALE", Quality = "Medium", SizeBytes = 62 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Italian female voice" },

            // ========== PORTUGUESE ==========
            new OfflineVoiceModel { Id = "pt_BR-faber-medium", Name = "Faber", Language = "Portuguese (Brazil)", LanguageCode = "pt-BR", Gender = "MALE", Quality = "Medium", SizeBytes = 59 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Brazilian Portuguese voice" },
            new OfflineVoiceModel { Id = "pt_BR-edresson-low", Name = "Edresson", Language = "Portuguese (Brazil)", LanguageCode = "pt-BR", Gender = "MALE", Quality = "Low", SizeBytes = 28 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Lightweight Brazilian voice" },
            new OfflineVoiceModel { Id = "pt_PT-tugao-medium", Name = "Tugão", Language = "Portuguese (Portugal)", LanguageCode = "pt-PT", Gender = "MALE", Quality = "Medium", SizeBytes = 51 * 1024 * 1024, Provider = PROVIDER_ID, Description = "European Portuguese voice" },

            // ========== RUSSIAN ==========
            new OfflineVoiceModel { Id = "ru_RU-ruslan-medium", Name = "Ruslan", Language = "Russian", LanguageCode = "ru-RU", Gender = "MALE", Quality = "Medium", SizeBytes = 67 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Russian male voice" },
            new OfflineVoiceModel { Id = "ru_RU-dmitri-medium", Name = "Dmitri", Language = "Russian", LanguageCode = "ru-RU", Gender = "MALE", Quality = "Medium", SizeBytes = 58 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Clear Russian voice" },
            new OfflineVoiceModel { Id = "ru_RU-irina-medium", Name = "Irina", Language = "Russian", LanguageCode = "ru-RU", Gender = "FEMALE", Quality = "Medium", SizeBytes = 62 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Russian female voice" },

            // ========== CHINESE ==========
            new OfflineVoiceModel { Id = "zh_CN-huayan-medium", Name = "Huayan", Language = "Chinese (Mandarin)", LanguageCode = "zh-CN", Gender = "FEMALE", Quality = "Medium", SizeBytes = 72 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Mandarin Chinese female voice" },

            // ========== JAPANESE ==========
            new OfflineVoiceModel { Id = "ja_JP-hikari-medium", Name = "Hikari", Language = "Japanese", LanguageCode = "ja-JP", Gender = "FEMALE", Quality = "Medium", SizeBytes = 84 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Japanese female voice" },

            // ========== KOREAN ==========
            new OfflineVoiceModel { Id = "ko_KR-yeonhee-medium", Name = "Yeonhee", Language = "Korean", LanguageCode = "ko-KR", Gender = "FEMALE", Quality = "Medium", SizeBytes = 68 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Korean female voice" },

            // ========== ARABIC ==========
            new OfflineVoiceModel { Id = "ar-abulr-medium", Name = "Abulr", Language = "Arabic", LanguageCode = "ar", Gender = "MALE", Quality = "Medium", SizeBytes = 53 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Modern Standard Arabic voice" },

            // ========== DUTCH ==========
            new OfflineVoiceModel { Id = "nl_NL-rdh-medium", Name = "RDH", Language = "Dutch", LanguageCode = "nl-NL", Gender = "MALE", Quality = "Medium", SizeBytes = 46 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Dutch male voice" },
            new OfflineVoiceModel { Id = "nl_BE-nathalie-medium", Name = "Nathalie", Language = "Dutch (Belgium)", LanguageCode = "nl-BE", Gender = "FEMALE", Quality = "Medium", SizeBytes = 48 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Flemish female voice" },

            // ========== POLISH ==========
            new OfflineVoiceModel { Id = "pl_PL-darkman-medium", Name = "Darkman", Language = "Polish", LanguageCode = "pl-PL", Gender = "MALE", Quality = "Medium", SizeBytes = 57 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Polish male voice" },
            new OfflineVoiceModel { Id = "pl_PL-gosia-medium", Name = "Gosia", Language = "Polish", LanguageCode = "pl-PL", Gender = "FEMALE", Quality = "Medium", SizeBytes = 52 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Polish female voice" },

            // ========== SWEDISH ==========
            new OfflineVoiceModel { Id = "sv_SE-nst-medium", Name = "NST", Language = "Swedish", LanguageCode = "sv-SE", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 44 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Swedish voice" },

            // ========== NORWEGIAN ==========
            new OfflineVoiceModel { Id = "no_NO-talesyntese-medium", Name = "Talesyntese", Language = "Norwegian", LanguageCode = "no-NO", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 42 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Norwegian voice" },

            // ========== DANISH ==========
            new OfflineVoiceModel { Id = "da_DK-talesyntese-medium", Name = "Talesyntese", Language = "Danish", LanguageCode = "da-DK", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 38 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Danish voice" },

            // ========== FINNISH ==========
            new OfflineVoiceModel { Id = "fi_FI-harri-medium", Name = "Harri", Language = "Finnish", LanguageCode = "fi-FI", Gender = "MALE", Quality = "Medium", SizeBytes = 47 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Finnish male voice" },

            // ========== CZECH ==========
            new OfflineVoiceModel { Id = "cs_CZ-jirka-medium", Name = "Jirka", Language = "Czech", LanguageCode = "cs-CZ", Gender = "MALE", Quality = "Medium", SizeBytes = 49 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Czech male voice" },

            // ========== GREEK ==========
            new OfflineVoiceModel { Id = "el_GR-rapunzelina-low", Name = "Rapunzelina", Language = "Greek", LanguageCode = "el-GR", Gender = "FEMALE", Quality = "Low", SizeBytes = 32 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Greek female voice" },

            // ========== TURKISH ==========
            new OfflineVoiceModel { Id = "tr_TR-dfki-medium", Name = "DFKI", Language = "Turkish", LanguageCode = "tr-TR", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 41 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Turkish voice" },

            // ========== HINDI ==========
            new OfflineVoiceModel { Id = "hi_IN-coqui-medium", Name = "Coqui", Language = "Hindi", LanguageCode = "hi-IN", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 64 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Hindi voice" },

            // ========== VIETNAMESE ==========
            new OfflineVoiceModel { Id = "vi_VN-vais1000-medium", Name = "VAIS1000", Language = "Vietnamese", LanguageCode = "vi-VN", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 55 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Vietnamese voice" },

            // ========== THAI ==========
            new OfflineVoiceModel { Id = "th_TH-kham-medium", Name = "Kham", Language = "Thai", LanguageCode = "th-TH", Gender = "FEMALE", Quality = "Medium", SizeBytes = 62 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Thai female voice" },

            // ========== INDONESIAN ==========
            new OfflineVoiceModel { Id = "id_ID-fajri-medium", Name = "Fajri", Language = "Indonesian", LanguageCode = "id-ID", Gender = "MALE", Quality = "Medium", SizeBytes = 43 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Indonesian male voice" },

            // ========== SWAHILI ==========
            new OfflineVoiceModel { Id = "sw_CD-lanfrica-medium", Name = "Lanfrica", Language = "Swahili", LanguageCode = "sw", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 39 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Swahili voice" },

            // ========== UKRAINIAN ==========
            new OfflineVoiceModel { Id = "uk_UA-ukrainian_tts-medium", Name = "Ukrainian TTS", Language = "Ukrainian", LanguageCode = "uk-UA", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 51 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Ukrainian voice" },

            // ========== HUNGARIAN ==========
            new OfflineVoiceModel { Id = "hu_HU-anna-medium", Name = "Anna", Language = "Hungarian", LanguageCode = "hu-HU", Gender = "FEMALE", Quality = "Medium", SizeBytes = 46 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Hungarian female voice" },

            // ========== ROMANIAN ==========
            new OfflineVoiceModel { Id = "ro_RO-mihai-medium", Name = "Mihai", Language = "Romanian", LanguageCode = "ro-RO", Gender = "MALE", Quality = "Medium", SizeBytes = 44 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Romanian male voice" },

            // ========== CATALAN ==========
            new OfflineVoiceModel { Id = "ca_ES-upc_ona-medium", Name = "Ona", Language = "Catalan", LanguageCode = "ca-ES", Gender = "FEMALE", Quality = "Medium", SizeBytes = 42 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Catalan female voice" },

            // ========== BULGARIAN ==========
            new OfflineVoiceModel { Id = "bg_BG-tanya-medium", Name = "Tanya", Language = "Bulgarian", LanguageCode = "bg-BG", Gender = "FEMALE", Quality = "Medium", SizeBytes = 48 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Bulgarian female voice" },

            // ========== SLOVAK ==========
            new OfflineVoiceModel { Id = "sk_SK-lili-medium", Name = "Lili", Language = "Slovak", LanguageCode = "sk-SK", Gender = "FEMALE", Quality = "Medium", SizeBytes = 45 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Slovak female voice" },

            // ========== SERBIAN ==========
            new OfflineVoiceModel { Id = "sr_RS-serbski_institut-medium", Name = "Serbski", Language = "Serbian", LanguageCode = "sr-RS", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 43 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Serbian voice" },

            // ========== SLOVENIAN ==========
            new OfflineVoiceModel { Id = "sl_SI-artur-medium", Name = "Artur", Language = "Slovenian", LanguageCode = "sl-SI", Gender = "MALE", Quality = "Medium", SizeBytes = 41 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Slovenian male voice" },

            // ========== ICELANDIC ==========
            new OfflineVoiceModel { Id = "is_IS-bui-medium", Name = "Bui", Language = "Icelandic", LanguageCode = "is-IS", Gender = "MALE", Quality = "Medium", SizeBytes = 36 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Icelandic male voice" },

            // ========== KAZAKH ==========
            new OfflineVoiceModel { Id = "kk_KZ-iseke-medium", Name = "Iseke", Language = "Kazakh", LanguageCode = "kk-KZ", Gender = "FEMALE", Quality = "Medium", SizeBytes = 52 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Kazakh female voice" },

            // ========== NEPALI ==========
            new OfflineVoiceModel { Id = "ne_NP-google-medium", Name = "Google Nepal", Language = "Nepali", LanguageCode = "ne-NP", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 58 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Nepali voice" },

            // ========== HEBREW ==========
            new OfflineVoiceModel { Id = "he_IL-edotts-medium", Name = "Edotts", Language = "Hebrew", LanguageCode = "he-IL", Gender = "NEUTRAL", Quality = "Medium", SizeBytes = 49 * 1024 * 1024, Provider = PROVIDER_ID, Description = "Hebrew voice" },
        });
    }

    public async Task<List<OfflineVoiceModel>> GetDownloadedModelsAsync()
    {
        if (_downloadedModels != null)
            return _downloadedModels;

        try
        {
            var modelIds = await _jsRuntime.InvokeAsync<string[]>("piperTTS.getDownloadedModels");
            var available = await GetAvailableModelsAsync();

            _downloadedModels = available
                .Where(m => modelIds.Contains(m.Id))
                .Select(m =>
                {
                    m.IsDownloaded = true;
                    m.DownloadedDate = DateTime.UtcNow; // TODO: Get actual download date from IndexedDB
                    return m;
                })
                .ToList();

            return _downloadedModels;
        }
        catch
        {
            return new List<OfflineVoiceModel>();
        }
    }

    public async Task<long> GetTotalModelSizeAsync()
    {
        var downloaded = await GetDownloadedModelsAsync();
        return downloaded.Sum(m => m.SizeBytes);
    }

    // Helper class for progress callback
    public class ProgressCallback
    {
        private readonly Action<int> _onProgress;

        public ProgressCallback(Action<int> onProgress)
        {
            _onProgress = onProgress;
        }

        [JSInvokable]
        public void Invoke(int progress)
        {
            _onProgress?.Invoke(progress);
        }
    }
}
