/**
 * StudyCodeDisplay - Displays study code with QR code
 * Allows students to quickly scan and access their progress on mobile
 */

'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface StudyCodeDisplayProps {
  studyCode: string;
  showQR?: boolean;
  showActions?: boolean;
  onSwitchCode?: () => void;
  size?: 'small' | 'medium' | 'large';
}

export function StudyCodeDisplay({
  studyCode,
  showQR = true,
  showActions = true,
  onSwitchCode,
  size = 'medium'
}: StudyCodeDisplayProps) {
  const [showCopied, setShowCopied] = useState(false);
  const [showQRExpanded, setShowQRExpanded] = useState(false);

  // Generate URL with study code for QR code
  const appUrl = typeof window !== 'undefined'
    ? `${window.location.origin}?code=${studyCode}`
    : `https://yourapp.com?code=${studyCode}`;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(studyCode);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDownloadQR = () => {
    // Get the QR code SVG element
    const svg = document.getElementById(`qr-code-${studyCode}`);
    if (!svg) return;

    // Convert SVG to data URL
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx?.drawImage(img, 0, 0);

      // Download as PNG
      const pngFile = canvas.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.download = `study-code-${studyCode}.png`;
      downloadLink.href = pngFile;
      downloadLink.click();
    };

    img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
  };

  const sizeClasses = {
    small: 'text-lg',
    medium: 'text-2xl',
    large: 'text-3xl'
  };

  const qrSizes = {
    small: 128,
    medium: 200,
    large: 256
  };

  return (
    <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-6 border-2 border-indigo-200 dark:border-indigo-800">
      <div className="flex items-start justify-between gap-6">
        {/* Study Code Text */}
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Your Study Code
          </h3>
          <code className={`${sizeClasses[size]} font-mono font-bold text-indigo-600 dark:text-indigo-400 bg-white dark:bg-gray-900 px-4 py-2 rounded-lg inline-block`}>
            {studyCode}
          </code>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-3">
            Remember or write down your study code, <code className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{studyCode}</code>, to access your progress from any device
          </p>
          {onSwitchCode && (
            <button
              onClick={onSwitchCode}
              className="block text-sm text-gray-500 dark:text-gray-400 hover:underline mt-3"
            >
              Enter a different code
            </button>
          )}

          {showActions && (
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleCopyCode}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium text-sm"
              >
                {showCopied ? '✓ Copied!' : '📋 Copy Code'}
              </button>
              {showQR && (
                <button
                  onClick={() => setShowQRExpanded(!showQRExpanded)}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium text-sm"
                >
                  {showQRExpanded ? '📱 Hide QR' : '📱 Show QR'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* QR Code - Always visible on desktop, toggleable on mobile */}
        {showQR && (
          <div className="hidden md:flex flex-col items-center gap-2">
            <div className="bg-white p-3 rounded-lg shadow-md">
              <QRCodeSVG
                id={`qr-code-${studyCode}`}
                value={appUrl}
                size={qrSizes[size]}
                level="H"
                includeMargin={true}
              />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400 text-center max-w-[200px]">
              Scan with your phone to access your learning code
            </p>
            {showActions && (
              <button
                onClick={handleDownloadQR}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Download QR Code
              </button>
            )}
          </div>
        )}
      </div>

      {/* Mobile QR Code (expandable) */}
      {showQR && showQRExpanded && (
        <div className="md:hidden mt-4 pt-4 border-t border-indigo-200 dark:border-indigo-700 flex flex-col items-center gap-2">
          <div className="bg-white p-3 rounded-lg shadow-md">
            <QRCodeSVG
              id={`qr-code-mobile-${studyCode}`}
              value={appUrl}
              size={200}
              level="H"
              includeMargin={true}
            />
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 text-center">
            Scan with your phone to access your progress
          </p>
          {showActions && (
            <button
              onClick={handleDownloadQR}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Download QR Code
            </button>
          )}
        </div>
      )}
    </div>
  );
}
