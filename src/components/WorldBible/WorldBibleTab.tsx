import type {
  Character,
  WorldSetting,
  Chapter,
  Volume,
  StoryMemory,
} from '../../types/novel';
import { Users, ShieldAlert, Brain } from 'lucide-react';
import { CharacterManager } from './CharacterManager';
import { SettingManager } from './SettingManager';
import { MemoryManager } from './MemoryManager';

export type WorldSubTab = 'characters' | 'settings' | 'memory';

export interface WorldBibleTabProps {
  characters: Character[];
  settings: WorldSetting[];
  chapters: Chapter[];
  volumes: Volume[];
  memory?: StoryMemory | null;
  worldSubTab: WorldSubTab;
  onWorldSubTabChange: (tab: WorldSubTab) => void;
  currentChapterNumber: number | undefined;
  onAddCharacter: (c: Character) => void;
  onUpdateCharacter: (c: Character) => void;
  onAddSetting: (s: WorldSetting) => void;
  onUpdateMemory: (memory: StoryMemory) => void;
  onPatchBible: (patch: { memory?: StoryMemory; characters?: Character[] }) => void;
}

/**
 * 世界观标签页容器（R1 拆分最后一步）。
 * 内部管理子页签头部（角色/设定/记忆），内容透传给对应管理器。
 */
export const WorldBibleTab: React.FC<WorldBibleTabProps> = ({
  characters,
  settings,
  chapters,
  volumes,
  memory,
  worldSubTab,
  onWorldSubTabChange,
  currentChapterNumber,
  onAddCharacter,
  onUpdateCharacter,
  onAddSetting,
  onUpdateMemory,
  onPatchBible,
}) => {
  const pinnedFacts = (memory?.pinnedFacts || []).filter((f) => f.status === 'pinned').length;
  const openThreads = (memory?.openThreads || []).filter((t) => t.status !== 'resolved').length;

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      <div className="border-b border-neutral-200 bg-white px-8 py-3 flex items-center space-x-8 shadow-sm overflow-x-auto">
        <button
          onClick={() => onWorldSubTabChange('characters')}
          className={`flex items-center space-x-2 text-xs font-bold transition-all py-1.5 border-b-2 shrink-0 ${
            worldSubTab === 'characters'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <Users size={15} />
          <span>角色图谱与动机 ({characters.length})</span>
        </button>

        <button
          onClick={() => onWorldSubTabChange('settings')}
          className={`flex items-center space-x-2 text-xs font-bold transition-all py-1.5 border-b-2 shrink-0 ${
            worldSubTab === 'settings'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <ShieldAlert size={15} />
          <span>世界观设定与核心红线铁律 ({settings.length})</span>
        </button>

        <button
          onClick={() => onWorldSubTabChange('memory')}
          className={`flex items-center space-x-2 text-xs font-bold transition-all py-1.5 border-b-2 shrink-0 ${
            worldSubTab === 'memory'
              ? 'border-violet-600 text-violet-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <Brain size={15} />
          <span>书级记忆 ({pinnedFacts}事实/{openThreads}伏笔)</span>
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {worldSubTab === 'characters' ? (
          <CharacterManager
            characters={characters}
            onAddCharacter={onAddCharacter}
            onUpdateCharacter={onUpdateCharacter}
          />
        ) : worldSubTab === 'settings' ? (
          <SettingManager settings={settings} onAddSetting={onAddSetting} />
        ) : (
          <MemoryManager
            memory={memory}
            characters={characters}
            currentChapterNumber={currentChapterNumber}
            chapters={chapters}
            volumes={volumes}
            onUpdateMemory={onUpdateMemory}
            onPatchBible={onPatchBible}
          />
        )}
      </div>
    </div>
  );
};
