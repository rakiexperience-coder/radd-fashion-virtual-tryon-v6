/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import StartScreen from './components/StartScreen';
import Canvas from './components/Canvas';
import WardrobePanel from './components/WardrobeModal';
import OutfitStack from './components/OutfitStack';
import { generateVirtualTryOnImage, generatePoseVariation, generateOutfitFromMoodBoard, refineOutfitWithGemini } from './services/geminiService';
import { OutfitLayer, WardrobeItem } from './types';
import { DownloadIcon, RotateCcwIcon } from './components/icons';
import { defaultWardrobe } from './wardrobe';
import Footer from './components/Footer';
import { getFriendlyErrorMessage } from './lib/utils';
import Spinner from './components/Spinner';
import MoodBoardPanel from './components/AddProductModal';
import GenerationHistory, { HistoryImage } from './components/GenerationHistory';

const POSE_INSTRUCTIONS = [
  "Slightly turned, 3/4 view",
  "Side profile view",
  "Walking towards camera",
  "Leaning against a wall",
  "Sitting legs crossed hand on chin, sitting on a chair",
  "Sitting legs crossed on the floor",
  "Runway walk",
  "Playful twirl",
  "Cross-legged stance",
  "Hand in hair"
];

const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);

    // DEPRECATED: mediaQueryList.addListener(listener);
    mediaQueryList.addEventListener('change', listener);
    
    // Check again on mount in case it changed between initial state and effect runs
    if (mediaQueryList.matches !== matches) {
      setMatches(mediaQueryList.matches);
    }

    return () => {
      // DEPRECATED: mediaQueryList.removeListener(listener);
      mediaQueryList.removeEventListener('change', listener);
    };
  }, [query, matches]);

  return matches;
};

// --- Gemini Chat Refinement Panel Component ---
interface GeminiChatPanelProps {
  onRefine: (prompt: string) => void;
  isLoading: boolean;
  refineError: string | null;
}

const GeminiChatPanel: React.FC<GeminiChatPanelProps> = ({ onRefine, isLoading, refineError }) => {
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !isLoading) {
      onRefine(prompt.trim());
      setPrompt('');
    }
  };

  return (
    <div className="chat-section pt-6 border-t border-gray-400/50">
      <h2 className="text-xl font-serif tracking-wider mb-3" style={{ color: '#A4823F' }}>Chat with Gemini (Refine Look)</h2>
       <p className="text-sm text-gray-600 mb-4">
        Describe a quick outfit fix, e.g., "remove the bag" or "change top to white crop".
      </p>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe a quick outfit fix..."
          disabled={isLoading}
          className="flex-grow w-full px-4 py-2 text-base text-gray-700 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#a4823f] focus:border-transparent transition disabled:opacity-60 disabled:bg-gray-100"
          aria-label="Outfit refinement prompt"
        />
        <button
          type="submit"
          disabled={isLoading || !prompt.trim()}
          className="flex-shrink-0 flex items-center justify-center px-4 py-2 text-base font-semibold text-white bg-[#a4823f] rounded-md cursor-pointer group hover:bg-[#937438] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          aria-label="Send refinement prompt"
        >
          Send
        </button>
      </form>
      {refineError && <p className="text-red-500 text-sm mt-2">{refineError}</p>}
    </div>
  );
};


const App: React.FC = () => {
  const [modelImageUrl, setModelImageUrl] = useState<string | null>(null);
  const [outfitHistory, setOutfitHistory] = useState<OutfitLayer[]>([]);
  const [currentOutfitIndex, setCurrentOutfitIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [currentPoseIndex, setCurrentPoseIndex] = useState(0);
  const [wardrobe, setWardrobe] = useState<WardrobeItem[]>(defaultWardrobe);
  const isMobile = useMediaQuery('(max-width: 767px)');

  const activeOutfitLayers = useMemo(() => 
    outfitHistory.slice(0, currentOutfitIndex + 1), 
    [outfitHistory, currentOutfitIndex]
  );
  
  const activeGarmentIds = useMemo(() => 
    activeOutfitLayers.map(layer => layer.garment?.id).filter(Boolean) as string[], 
    [activeOutfitLayers]
  );
  
  const displayImageUrl = useMemo(() => {
    if (outfitHistory.length === 0) return modelImageUrl;
    const currentLayer = outfitHistory[currentOutfitIndex];
    if (!currentLayer) return modelImageUrl;

    const poseInstruction = POSE_INSTRUCTIONS[currentPoseIndex];
    // Return the image for the current pose, or fallback to the first available image for the current layer.
    // This ensures an image is shown even while a new pose is generating.
    return currentLayer.poseImages[poseInstruction] ?? Object.values(currentLayer.poseImages)[0];
  }, [outfitHistory, currentOutfitIndex, currentPoseIndex, modelImageUrl]);

  const availablePoseKeys = useMemo(() => {
    if (outfitHistory.length === 0) return [];
    const currentLayer = outfitHistory[currentOutfitIndex];
    return currentLayer ? Object.keys(currentLayer.poseImages) : [];
  }, [outfitHistory, currentOutfitIndex]);

  const generationHistory = useMemo((): HistoryImage[] => {
    const uniqueImages = new Map<string, { outfitIndex: number; poseInstruction: string }>();
    
    outfitHistory.forEach((layer, outfitIndex) => {
      // Use POSE_INSTRUCTIONS to iterate to maintain a somewhat predictable order for images within the same layer
      POSE_INSTRUCTIONS.forEach(poseInstruction => {
        const imageUrl = layer.poseImages[poseInstruction];
        if (imageUrl && !uniqueImages.has(imageUrl)) {
          uniqueImages.set(imageUrl, { outfitIndex, poseInstruction });
        }
      });
    });

    // The map preserves insertion order, so this will be chronological.
    return Array.from(uniqueImages.entries()).map(([imageUrl, data]) => ({
      imageUrl,
      ...data,
    }));
  }, [outfitHistory]);

  const handleModelFinalized = (url: string) => {
    setModelImageUrl(url);
    setOutfitHistory([{
      garment: null,
      poseImages: { [POSE_INSTRUCTIONS[0]]: url }
    }]);
    setCurrentOutfitIndex(0);
  };

  const handleStartOver = () => {
    setModelImageUrl(null);
    setOutfitHistory([]);
    setCurrentOutfitIndex(0);
    setIsLoading(false);
    setLoadingMessage('');
    setError(null);
    setRefineError(null);
    setCurrentPoseIndex(0);
    setWardrobe(defaultWardrobe);
  };

  const handleDownload = () => {
    if (!displayImageUrl) return;
    const link = document.createElement('a');
    link.href = displayImageUrl;
    link.download = 'radd-fashion-outfit.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleGarmentSelect = useCallback(async (garmentFile: File, garmentInfo: WardrobeItem) => {
    if (!displayImageUrl || isLoading) return;

    // Caching: Check if we are re-applying a previously generated layer
    const nextLayer = outfitHistory[currentOutfitIndex + 1];
    if (nextLayer && nextLayer.garment?.id === garmentInfo.id) {
        setCurrentOutfitIndex(prev => prev + 1);
        setCurrentPoseIndex(0); // Reset pose when changing layer
        return;
    }

    setError(null);
    setRefineError(null);
    setIsLoading(true);
    setLoadingMessage(`Adding ${garmentInfo.name}...`);

    try {
      const newImageUrl = await generateVirtualTryOnImage(displayImageUrl, garmentFile);
      const currentPoseInstruction = POSE_INSTRUCTIONS[currentPoseIndex];
      
      const newLayer: OutfitLayer = { 
        garment: garmentInfo, 
        poseImages: { [currentPoseInstruction]: newImageUrl } 
      };

      setOutfitHistory(prevHistory => {
        // Cut the history at the current point before adding the new layer
        const newHistory = prevHistory.slice(0, currentOutfitIndex + 1);
        return [...newHistory, newLayer];
      });
      setCurrentOutfitIndex(prev => prev + 1);
      
      // Add to personal wardrobe if it's not already there
      setWardrobe(prev => {
        if (prev.find(item => item.id === garmentInfo.id)) {
            return prev;
        }
        return [...prev, garmentInfo];
      });
    } catch (error) {
      // FIX: Cast error to string to satisfy getFriendlyErrorMessage parameter type.
      setError(getFriendlyErrorMessage(String(error), 'Failed to apply garment'));
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }, [displayImageUrl, isLoading, currentPoseIndex, outfitHistory, currentOutfitIndex]);

  const handleRemoveLastGarment = () => {
    if (currentOutfitIndex > 0) {
      setCurrentOutfitIndex(prevIndex => prevIndex - 1);
      setCurrentPoseIndex(0); // Reset pose to default when removing a layer
    }
  };
  
  const handlePoseSelect = useCallback(async (newIndex: number) => {
    if (isLoading || outfitHistory.length === 0 || newIndex === currentPoseIndex) return;
    
    const poseInstruction = POSE_INSTRUCTIONS[newIndex];
    const currentLayer = outfitHistory[currentOutfitIndex];

    // If pose already exists, just update the index to show it.
    if (currentLayer.poseImages[poseInstruction]) {
      setCurrentPoseIndex(newIndex);
      return;
    }

    // Pose doesn't exist, so generate it.
    // Use an existing image from the current layer as the base.
    const baseImageForPoseChange = Object.values(currentLayer.poseImages)[0];
    if (!baseImageForPoseChange) return; // Should not happen

    setError(null);
    setRefineError(null);
    setIsLoading(true);
    setLoadingMessage(`Changing pose...`);
    
    const prevPoseIndex = currentPoseIndex;
    // Optimistically update the pose index so the pose name changes in the UI
    setCurrentPoseIndex(newIndex);

    try {
      const newImageUrl = await generatePoseVariation(baseImageForPoseChange, poseInstruction);
      setOutfitHistory(prevHistory => {
        const newHistory = [...prevHistory];
        const updatedLayer = newHistory[currentOutfitIndex];
        updatedLayer.poseImages[poseInstruction] = newImageUrl;
        return newHistory;
      });
    } catch (error) {
      // FIX: Cast error to string to satisfy getFriendlyErrorMessage parameter type.
      setError(getFriendlyErrorMessage(String(error), 'Failed to change pose'));
      // Revert pose index on failure
      setCurrentPoseIndex(prevPoseIndex);
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }, [currentPoseIndex, outfitHistory, isLoading, currentOutfitIndex]);

  const handleMoodBoardSelect = useCallback(async (moodFile: File) => {
    const baseModelUrl = modelImageUrl;
    if (!baseModelUrl || isLoading) return;

    setError(null);
    setRefineError(null);
    setIsLoading(true);
    setLoadingMessage('Applying your mood board look…');

    try {
        const newImageUrl = await generateOutfitFromMoodBoard(baseModelUrl, moodFile);

        const moodBoardGarment: WardrobeItem = {
            id: `moodboard-${moodFile.name}-${Date.now()}`,
            name: `Mood Board Look`,
            url: URL.createObjectURL(moodFile),
        };

        const newLayer: OutfitLayer = {
            garment: moodBoardGarment,
            poseImages: { [POSE_INSTRUCTIONS[0]]: newImageUrl }
        };

        setOutfitHistory(prevHistory => {
            const historyUpToBase = prevHistory.slice(0, 1); // Reset to base model
            return [...historyUpToBase, newLayer];
        });
        setCurrentOutfitIndex(1);
        setCurrentPoseIndex(0);

        setWardrobe(prev => {
            if (prev.find(item => item.id === moodBoardGarment.id)) {
                return prev;
            }
            return [...prev, moodBoardGarment];
        });

    } catch (error) {
        // FIX: Cast error to string to satisfy getFriendlyErrorMessage parameter type.
        setError(getFriendlyErrorMessage(String(error), 'Failed to apply mood board'));
    } finally {
        setIsLoading(false);
        setLoadingMessage('');
    }
  }, [modelImageUrl, isLoading]);

  const handleGeminiChatRefine = useCallback(async (prompt: string) => {
    if (!displayImageUrl || isLoading) return;

    setError(null);
    setRefineError(null);
    setIsLoading(true);
    setLoadingMessage('Updating outfit with Gemini...');

    try {
      const newImageUrl = await refineOutfitWithGemini(displayImageUrl, prompt);
      const currentPoseInstruction = POSE_INSTRUCTIONS[currentPoseIndex];

      setOutfitHistory(prevHistory => {
        const newHistory = [...prevHistory];
        const currentLayer = { ...newHistory[currentOutfitIndex] };
        const newPoseImages = { ...currentLayer.poseImages, [currentPoseInstruction]: newImageUrl };
        currentLayer.poseImages = newPoseImages;
        newHistory[currentOutfitIndex] = currentLayer;
        return newHistory;
      });
    } catch (error) {
      // FIX: Cast error to string to satisfy getFriendlyErrorMessage parameter type.
      setRefineError(getFriendlyErrorMessage(String(error), 'Could not update outfit — please try again.'));
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }, [displayImageUrl, isLoading, currentOutfitIndex, currentPoseIndex]);

  const handleHistoryImageSelect = useCallback((outfitIndex: number, poseInstruction: string) => {
    if (isLoading) return;
    
    const poseIndex = POSE_INSTRUCTIONS.indexOf(poseInstruction);
    
    if (poseIndex !== -1) {
      setCurrentOutfitIndex(outfitIndex);
      setCurrentPoseIndex(poseIndex);
    }
  }, [isLoading]);

  const viewVariants = {
    initial: { opacity: 0, y: 15 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -15 },
  };

  return (
    <div className="font-sans bg-white">
      <AnimatePresence mode="wait">
        {!modelImageUrl ? (
          <motion.div
            key="start-screen"
            className="w-screen min-h-screen flex items-start sm:items-center justify-center bg-gray-50 p-4"
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.5, ease: 'easeInOut' }}
          >
            <StartScreen onModelFinalized={handleModelFinalized} />
          </motion.div>
        ) : (
          <motion.div
            key="main-app"
            className="min-h-screen flex flex-col"
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.5, ease: 'easeInOut' }}
          >
            <main className="flex-1 pb-12 md:pb-24">
              <div className="mx-auto max-w-[1200px] w-full px-4 md:px-6 lg:px-8 flex flex-col md:flex-row gap-8 md:gap-12 md:items-start pt-6 md:pt-8">
                {/* --- MAIN / PREVIEW COLUMN --- */}
                <section className="flex-1 min-w-0 md:sticky md:top-8" id="preview-column">
                  <div className="flex flex-col items-center gap-4 mx-auto w-full max-w-[720px]">
                    <div className="w-full">
                      <Canvas 
                        displayImageUrl={displayImageUrl}
                        isLoading={isLoading}
                        loadingMessage={loadingMessage}
                        onSelectPose={handlePoseSelect}
                        poseInstructions={POSE_INSTRUCTIONS}
                        currentPoseIndex={currentPoseIndex}
                        availablePoseKeys={availablePoseKeys}
                      />
                    </div>
                    <div className="flex items-center gap-3 justify-center sticky md:static bottom-4 z-10 w-full">
                      <button 
                          onClick={handleStartOver}
                          className="flex items-center justify-center bg-[#a4823f] text-white border-none px-6 py-2.5 rounded-full font-semibold cursor-pointer transition-opacity hover:opacity-90 whitespace-nowrap"
                      >
                          <RotateCcwIcon className="w-4 h-4 mr-2" />
                          Start Over
                      </button>
                      {displayImageUrl && (
                        <button 
                            onClick={handleDownload}
                            className="flex items-center justify-center bg-[#a4823f] text-white border-none px-6 py-2.5 rounded-full font-semibold cursor-pointer transition-opacity hover:opacity-90 whitespace-nowrap"
                        >
                            <DownloadIcon className="w-4 h-4 mr-2" />
                            Download
                        </button>
                      )}
                    </div>
                  </div>
                </section>

                {/* --- RIGHT / CONTROLS COLUMN --- */}
                <aside
                  id="controls-column"
                  className="w-full md:w-[360px] lg:w-[380px] xl:w-[420px] md:shrink-0"
                >
                    <div className="flex flex-col gap-[1.2rem]">
                      {error && (
                        <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded-md" role="alert">
                          <p className="font-bold">Error</p>
                          <p>{error}</p>
                        </div>
                      )}
                      <OutfitStack 
                        outfitHistory={activeOutfitLayers}
                        onRemoveLastGarment={handleRemoveLastGarment}
                      />
                      <MoodBoardPanel
                        onMoodBoardSelect={handleMoodBoardSelect}
                        isLoading={isLoading}
                      />
                      <WardrobePanel
                        onGarmentSelect={handleGarmentSelect}
                        activeGarmentIds={activeGarmentIds}
                        isLoading={isLoading}
                        wardrobe={wardrobe}
                      />
                      <GeminiChatPanel
                        onRefine={handleGeminiChatRefine}
                        isLoading={isLoading}
                        refineError={refineError}
                      />
                      <GenerationHistory
                        historyImages={generationHistory}
                        onSelect={handleHistoryImageSelect}
                        currentImageUrl={displayImageUrl}
                        isLoading={isLoading}
                      />
                    </div>
                </aside>
              </div>
            </main>
            
            <AnimatePresence>
              {isLoading && isMobile && (
                <motion.div
                  className="fixed inset-0 bg-white/80 backdrop-blur-md flex flex-col items-center justify-center z-50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Spinner />
                  {loadingMessage && (
                    <p className="text-lg font-serif text-gray-700 mt-4 text-center px-4">{loadingMessage}</p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            <Footer isOnDressingScreen={!!modelImageUrl} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;