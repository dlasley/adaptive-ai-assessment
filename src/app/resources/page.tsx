'use client';

import { useState, useEffect } from 'react';
import { units } from '@/lib/units';
import { getResourcesByUnit, getAllResources } from '@/lib/learning-resources-client';
import ResourceCard from '@/components/ResourceCard';
import LoadingSpinner from '@/components/LoadingSpinner';
import type { LearningResource } from '@/types';

type ViewMode = 'unit' | 'topic';

export default function ResourcesPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('unit');
  const [selectedUnit, setSelectedUnit] = useState(units[0].id);
  const [resources, setResources] = useState<LearningResource[]>([]);
  const [allResources, setAllResources] = useState<LearningResource[]>([]);
  const [loading, setLoading] = useState(true);

  // Load resources for "By Unit" view
  useEffect(() => {
    if (viewMode !== 'unit') return;

    const load = async () => {
      setLoading(true);
      const data = await getResourcesByUnit(selectedUnit);
      setResources(data);
      setLoading(false);
    };
    load();
  }, [selectedUnit, viewMode]);

  // Load all resources for "By Topic" view
  useEffect(() => {
    if (viewMode !== 'topic') return;

    const load = async () => {
      setLoading(true);
      const data = await getAllResources();
      setAllResources(data);
      setLoading(false);
    };
    load();
  }, [viewMode]);

  // Deduplicate resources by URL (same video can appear in multiple units)
  const dedupeByUrl = (items: LearningResource[]): LearningResource[] => {
    const seen = new Set<string>();
    return items.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  };

  // Group resources by topic
  const groupByTopic = (items: LearningResource[]): Map<string, LearningResource[]> => {
    const grouped = new Map<string, LearningResource[]>();
    for (const r of items) {
      const existing = grouped.get(r.topic) || [];
      existing.push(r);
      grouped.set(r.topic, existing);
    }
    return grouped;
  };

  const unitResourcesByTopic = groupByTopic(dedupeByUrl(resources));
  const allResourcesByTopic = groupByTopic(dedupeByUrl(allResources));

  const selectedUnitData = units.find(u => u.id === selectedUnit);

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
          Learning Resources
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-300">
          Videos and study materials organized by topic
        </p>
      </div>

      {/* View Toggle */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <button
            onClick={() => setViewMode('unit')}
            className={`px-6 py-2.5 text-sm font-semibold transition-colors ${
              viewMode === 'unit'
                ? 'bg-indigo-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            By Unit
          </button>
          <button
            onClick={() => setViewMode('topic')}
            className={`px-6 py-2.5 text-sm font-semibold transition-colors ${
              viewMode === 'topic'
                ? 'bg-indigo-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            By Topic
          </button>
        </div>
      </div>

      {/* By Unit View */}
      {viewMode === 'unit' && (
        <>
          {/* Unit Tabs */}
          <div className="flex flex-wrap gap-2 justify-center">
            {units.map((unit) => (
              <button
                key={unit.id}
                onClick={() => setSelectedUnit(unit.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  selectedUnit === unit.id
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-600 dark:hover:text-indigo-400'
                }`}
              >
                {unit.title}
              </button>
            ))}
          </div>

          {/* Unit Content */}
          {loading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : (
            <div className="space-y-8">
              {selectedUnitData && (
                <div className="text-center">
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {selectedUnitData.title}
                  </h2>
                  {selectedUnitData.label && (
                    <p className="text-gray-600 dark:text-gray-400 mt-1">{selectedUnitData.label}</p>
                  )}
                </div>
              )}

              {unitResourcesByTopic.size > 0 ? (
                [...unitResourcesByTopic.entries()].map(([topic, topicResources]) => (
                  <div key={topic} className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                          {topic}
                        </h3>
                        <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                          {topicResources.length} {topicResources.length === 1 ? 'resource' : 'resources'}
                        </span>
                      </div>
                    </div>
                    <div className="p-4 space-y-2">
                      {topicResources.map((resource) => (
                        <ResourceCard key={resource.id} resource={resource} />
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-xl shadow-lg">
                  <p className="text-gray-500 dark:text-gray-400">
                    No resources available for this unit yet.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* By Topic View */}
      {viewMode === 'topic' && (
        <>
          {loading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : (
            <div className="space-y-6">
              {allResourcesByTopic.size > 0 ? (
                [...allResourcesByTopic.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([topic, topicResources]) => {
                    // Get unique unit IDs for this topic
                    const topicUnitIds = [...new Set(topicResources.map(r => r.unit_id))];
                    const unitLabels = topicUnitIds
                      .map(id => units.find(u => u.id === id))
                      .filter(Boolean)
                      .map(u => u!.title);

                    return (
                      <div key={topic} className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div>
                              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                                {topic}
                              </h3>
                              <p className="text-sm text-gray-500 dark:text-gray-400">
                                {unitLabels.join(', ')}
                              </p>
                            </div>
                            <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                              {topicResources.length} {topicResources.length === 1 ? 'resource' : 'resources'}
                            </span>
                          </div>
                        </div>
                        <div className="p-4 space-y-2">
                          {topicResources.map((resource) => (
                            <ResourceCard key={resource.id} resource={resource} />
                          ))}
                        </div>
                      </div>
                    );
                  })
              ) : (
                <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-xl shadow-lg">
                  <p className="text-gray-500 dark:text-gray-400">
                    No resources available yet.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
