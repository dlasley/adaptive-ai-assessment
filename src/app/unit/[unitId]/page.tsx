'use client';

import { useParams, useRouter } from 'next/navigation';
import { units } from '@/lib/units';
import { useState } from 'react';

export default function UnitPage() {
  const params = useParams();
  const router = useRouter();
  const unitId = params.unitId as string;
  const unit = units.find((u) => u.id === unitId);

  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [numQuestions, setNumQuestions] = useState<number>(5);
  const [difficulty, setDifficulty] = useState<'beginner' | 'intermediate' | 'advanced'>('beginner');

  if (!unit) {
    return (
      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Unit not found</h2>
        <button
          onClick={() => router.push('/')}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
        >
          Back to Home
        </button>
      </div>
    );
  }

  const handleStartQuiz = () => {
    if (!selectedTopic) {
      alert('Please select a topic');
      return;
    }
    router.push(
      `/quiz/${unitId}?topic=${encodeURIComponent(selectedTopic)}&num=${numQuestions}&difficulty=${difficulty}`
    );
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center space-x-4 mb-6">
        <button
          onClick={() => router.push('/')}
          className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
        >
          ← Back to Units
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          {unit.title}
        </h2>
        <p className="text-gray-600 dark:text-gray-300 mb-6">{unit.description}</p>

        <div className="space-y-6">
          {/* Topic Selection */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Select a Topic to Practice:
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {unit.topics.map((topic) => (
                <button
                  key={topic}
                  onClick={() => setSelectedTopic(topic)}
                  className={`text-left p-4 rounded-lg border-2 transition-all ${
                    selectedTopic === topic
                      ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30'
                      : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400'
                  }`}
                >
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {topic}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Number of Questions */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Number of Questions: {numQuestions}
            </label>
            <input
              type="range"
              min="3"
              max="10"
              value={numQuestions}
              onChange={(e) => setNumQuestions(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>3</span>
              <span>10</span>
            </div>
          </div>

          {/* Difficulty Selection */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Difficulty Level:
            </label>
            <div className="flex gap-3">
              {(['beginner', 'intermediate', 'advanced'] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => setDifficulty(level)}
                  className={`flex-1 py-2 px-4 rounded-md border-2 transition-all capitalize ${
                    difficulty === level
                      ? 'border-indigo-600 bg-indigo-600 text-white'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-indigo-400'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          {/* Start Button */}
          <button
            onClick={handleStartQuiz}
            disabled={!selectedTopic}
            className={`w-full py-4 rounded-lg font-semibold text-lg transition-all ${
              selectedTopic
                ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl'
                : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {selectedTopic ? '🚀 Start Practice Session' : '👆 Select a topic to begin'}
          </button>
        </div>
      </div>
    </div>
  );
}
