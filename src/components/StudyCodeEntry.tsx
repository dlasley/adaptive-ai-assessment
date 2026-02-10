'use client';

import { useState, useEffect } from 'react';
import LoadingSpinner from '@/components/LoadingSpinner';
import {
  createStudyCode,
  storeStudyCode,
  getStudyCodeDetails,
  normalizeStudyCode,
  setSkipChoice,
} from '@/lib/study-codes';

interface StudyCodeEntryProps {
  onCodeEstablished: (code: string) => void;
  existingCode?: string | null;
  pendingCode?: string | null;
}

type Mode = 'choice' | 'entering' | 'creating' | 'confirming-swap';

export function StudyCodeEntry({
  onCodeEstablished,
  existingCode,
  pendingCode,
}: StudyCodeEntryProps) {
  const [mode, setMode] = useState<Mode>('choice');
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [codeToSwapTo, setCodeToSwapTo] = useState<string | null>(null);

  // If a pending QR code was passed in, go straight to swap confirmation
  useEffect(() => {
    if (pendingCode && existingCode) {
      setCodeToSwapTo(pendingCode);
      setMode('confirming-swap');
    }
  }, [pendingCode, existingCode]);

  const handleNewStudent = async () => {
    setMode('creating');
    try {
      const code = await createStudyCode();
      if (code) {
        setSkipChoice(rememberMe);
        onCodeEstablished(code);
      } else {
        setError('Failed to create study code. Please try again.');
        setMode('choice');
      }
    } catch {
      setError('Failed to create study code. Please try again.');
      setMode('choice');
    }
  };

  const handleSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const normalized = normalizeStudyCode(inputValue);
    if (!normalized) {
      setError('Please enter a study code.');
      return;
    }

    setIsValidating(true);
    try {
      const details = await getStudyCodeDetails(normalized);
      if (!details) {
        setError('Code not found. Check the spelling and try again.');
        setIsValidating(false);
        return;
      }

      // Code is valid - check for swap conflict
      if (existingCode && existingCode !== normalized) {
        setCodeToSwapTo(normalized);
        setMode('confirming-swap');
        setIsValidating(false);
        return;
      }

      // No conflict - store and proceed
      storeStudyCode(normalized);
      setSkipChoice(rememberMe);
      onCodeEstablished(normalized);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsValidating(false);
    }
  };

  const handleConfirmSwap = () => {
    if (!codeToSwapTo) return;
    storeStudyCode(codeToSwapTo);
    setSkipChoice(rememberMe);
    onCodeEstablished(codeToSwapTo);
  };

  const handleKeepCurrent = () => {
    if (!existingCode) return;
    storeStudyCode(existingCode);
    setSkipChoice(rememberMe);
    onCodeEstablished(existingCode);
  };

  // Shared "Remember me" checkbox
  const rememberMeCheckbox = (
    <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={rememberMe}
        onChange={(e) => setRememberMe(e.target.checked)}
        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
      />
      Remember me on this device
    </label>
  );

  if (mode === 'creating') {
    return (
      <div className="max-w-md mx-auto bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-8 border-2 border-indigo-200 dark:border-indigo-800 text-center">
        <LoadingSpinner size="md" className="mx-auto mb-4" />
        <p className="text-gray-600 dark:text-gray-300">Creating your study code...</p>
      </div>
    );
  }

  if (mode === 'confirming-swap') {
    return (
      <div className="max-w-md mx-auto bg-gradient-to-br from-amber-50 to-orange-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-8 border-2 border-amber-300 dark:border-amber-700 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Switch Study Code?
        </h3>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          You are currently using{' '}
          <span className="font-mono font-bold text-indigo-700 dark:text-indigo-400">
            {existingCode}
          </span>
          . Switching to{' '}
          <span className="font-mono font-bold text-indigo-700 dark:text-indigo-400">
            {codeToSwapTo}
          </span>{' '}
          will change your identity. Your previous progress is still saved under
          the old code.
        </p>
        <div className="pt-2">
          {rememberMeCheckbox}
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleConfirmSwap}
            className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
          >
            Switch Code
          </button>
          <button
            onClick={handleKeepCurrent}
            className="flex-1 py-2 px-4 bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-800 dark:text-white rounded-lg font-medium transition-colors"
          >
            Keep Current
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'entering') {
    return (
      <div className="max-w-md mx-auto bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-8 border-2 border-indigo-200 dark:border-indigo-800 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Enter Your Study Code
        </h3>
        <form onSubmit={handleSubmitCode} className="space-y-4">
          <div>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setError(null);
              }}
              placeholder="e.g. happy elephant"
              autoFocus
              className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white text-lg font-mono"
            />
            {error && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
          <div>
            {rememberMeCheckbox}
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isValidating}
              className="flex-1 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-lg font-medium transition-colors"
            >
              {isValidating ? 'Checking...' : 'Continue'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('choice');
                setError(null);
                setInputValue('');
              }}
              className="py-3 px-4 bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-800 dark:text-white rounded-lg font-medium transition-colors"
            >
              Back
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Default: choice screen
  return (
    <div className="max-w-md mx-auto bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-8 border-2 border-indigo-200 dark:border-indigo-800 space-y-6">
      <div className="text-center space-y-2">
        <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
          Welcome
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Start fresh or continue with an existing study code
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 text-center">
          {error}
        </p>
      )}

      <div className="text-center">
        {rememberMeCheckbox}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => setMode('entering')}
          className="py-4 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors shadow-md"
        >
          <div className="text-lg mb-1">I Have a Code</div>
          <div className="text-xs text-indigo-200">Enter existing code</div>
        </button>
        <button
          onClick={handleNewStudent}
          className="py-4 px-4 border-2 border-indigo-400 dark:border-indigo-500 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-gray-600 rounded-lg font-medium transition-colors"
        >
          <div className="text-lg mb-1">I&apos;m New</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Generate a code</div>
        </button>
      </div>
    </div>
  );
}
