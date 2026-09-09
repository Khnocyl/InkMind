import React, { useState } from 'react';
import type { Character, CharacterRole, CharacterStatus } from '../../types/novel';
import { UserPlus, ShieldAlert, Heart, MapPin, Eye, Award, Pencil, Trash2 } from 'lucide-react';

interface CharacterManagerProps {
  characters: Character[];
  onAddCharacter: (character: Character) => void;
  onUpdateCharacter: (character: Character) => void;
  /** 删除角色（App 侧会级联清理章节引用与其他角色的关系） */
  onDeleteCharacter: (id: string) => void;
}

export const CharacterManager: React.FC<CharacterManagerProps> = ({
  characters,
  onAddCharacter,
  onUpdateCharacter,
  onDeleteCharacter,
}) => {
  const [selectedCharId, setSelectedCharId] = useState<string>(characters[0]?.id || '');
  const [isCreating, setIsCreating] = useState(false);
  /** 编辑模式：复用录入表单，提交时走 onUpdateCharacter */
  const [isEditing, setIsEditing] = useState(false);

  const [formData, setFormData] = useState<Partial<Character>>({
    name: '',
    alias: '',
    role: '重要配角',
    status: '活跃',
    realmOrTitle: '筑基初境',
    currentLocation: '青云宗外门',
    personality: '',
    appearance: '',
    background: '',
    secretNotes: '',
    relations: [],
  });

  const selectedChar = characters.find((c) => c.id === selectedCharId) || characters[0];
  const isFormOpen = isCreating || isEditing;

  const startCreate = () => {
    setIsCreating(true);
    setIsEditing(false);
    setFormData({
      name: '',
      alias: '',
      role: '重要配角',
      status: '活跃',
      realmOrTitle: '筑基初境',
      currentLocation: '青云宗外门',
      personality: '',
      appearance: '',
      background: '',
      secretNotes: '',
      relations: [],
    });
  };

  const startEdit = () => {
    if (!selectedChar) return;
    setIsCreating(false);
    setIsEditing(true);
    setFormData({ ...selectedChar });
  };

  const closeForm = () => {
    setIsCreating(false);
    setIsEditing(false);
  };

  const getStatusStyle = (status: CharacterStatus) => {
    switch (status) {
      case '活跃':
        return 'bg-[#f0f9f4] text-[#1b5e20] border-[#2e8b57] dark:bg-[#0c2a18] dark:text-[#6ee7b7] dark:border-[#1e5a32]';
      case '重伤':
      case '被捕受困':
        return 'bg-[#fff5f5] text-[#b71c1c] border-[#d32f2f] dark:bg-[#321117] dark:text-[#fda4af] dark:border-[#7f1d2e]';
      default:
        return 'bg-[#f5f5f5] text-[#555555] border-[#999999] dark:bg-[#202024] dark:text-[#e4e4e7] dark:border-[#4a4a52]';
    }
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;
    if (isEditing && selectedChar) {
      // 保留 id / relations 等未在表单里的字段
      onUpdateCharacter({
        ...selectedChar,
        ...formData,
        id: selectedChar.id,
        relations: selectedChar.relations || [],
      } as Character);
      closeForm();
      return;
    }
    const newChar: Character = {
      id: `char-${Date.now()}`,
      name: formData.name || '无名角色',
      alias: formData.alias || '无称号',
      role: (formData.role as CharacterRole) || '重要配角',
      status: (formData.status as CharacterStatus) || '活跃',
      realmOrTitle: formData.realmOrTitle || '未知境界',
      currentLocation: formData.currentLocation || '未知地点',
      personality: formData.personality || '',
      appearance: formData.appearance || '',
      background: formData.background || '',
      secretNotes: formData.secretNotes || '',
      relations: formData.relations || [],
    };
    onAddCharacter(newChar);
    setSelectedCharId(newChar.id);
    closeForm();
  };

  const handleDelete = () => {
    if (!selectedChar) return;
    const ok = window.confirm(
      `删除角色「${selectedChar.name}」？\n\n将同时从各章节的出场角色中移除，并清理其他角色指向他的关系。此操作不可撤销。`
    );
    if (!ok) return;
    const remaining = characters.filter((c) => c.id !== selectedChar.id);
    onDeleteCharacter(selectedChar.id);
    setSelectedCharId(remaining[0]?.id || '');
  };

  const handleToggleStatus = (status: CharacterStatus) => {
    if (!selectedChar) return;
    onUpdateCharacter({
      ...selectedChar,
      status,
    });
  };

  return (
    <div className="flex-1 bg-white flex h-full overflow-hidden">
      <aside className="w-80 border-r border-[#e5e5e5] flex flex-col bg-[#fafafa] rounded-bl-[28px]">
        <div className="p-4 border-b border-[#e5e5e5] flex items-center justify-between">
          <span className="font-bold text-sm text-black">角色追踪表 ({characters.length})</span>
          <button
            onClick={startCreate}
            className="flex items-center space-x-1 bg-black text-white px-2.5 py-1 rounded text-xs font-medium hover:bg-neutral-800 transition-all"
          >
            <UserPlus size={13} />
            <span>新建角色</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[#f0f0f0]">
          {characters.map((char) => {
            const isSelected = char.id === selectedCharId && !isFormOpen;
            return (
              <div
                key={char.id}
                onClick={() => {
                  setSelectedCharId(char.id);
                  closeForm();
                }}
                className={`p-3.5 cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-white border-l-4 border-black shadow-sm'
                    : 'hover:bg-[#f3f3f3] border-l-4 border-transparent'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-sm text-black">{char.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${getStatusStyle(char.status)}`}>
                    {char.status}
                  </span>
                </div>
                <div className="text-xs text-[#555555] mb-1 font-serif">{char.alias}</div>
                <div className="flex items-center justify-between text-[11px] text-[#777777] mt-2">
                  <span className="bg-[#f0f0f0] px-1.5 py-0.5 rounded">{char.role}</span>
                  <span className="flex items-center space-x-1">
                    <MapPin size={11} />
                    <span>{char.currentLocation}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8 bg-white">
        {isFormOpen ? (
          <div className="max-w-3xl mx-auto">
            <h3 className="font-bold text-lg text-black mb-4 pb-2 border-b border-[#e5e5e5]">
              {isEditing
                ? `编辑角色：${selectedChar?.name || ''}`
                : '录入新角色（系统将在 RAG 检索时自动抓取本设定）'}
            </h3>
            <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-black mb-1">角色姓名 *</label>
                  <input
                    type="text"
                    required
                    placeholder="如：叶无痕"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black"
                  />
                </div>
                <div>
                  <label className="block font-bold text-black mb-1">江湖/宗门称号</label>
                  <input
                    type="text"
                    placeholder="如：盲算子 / 青云残剑"
                    value={formData.alias}
                    onChange={(e) => setFormData({ ...formData, alias: e.target.value })}
                    className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block font-bold text-black mb-1">定位</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as CharacterRole })}
                    className="w-full p-2 border border-[#cccccc] dark:border-neutral-700 rounded text-black dark:text-neutral-100 bg-white dark:bg-neutral-800 focus:outline-none focus:border-black dark:focus:border-neutral-400"
                  >
                    <option value="主角" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">主角</option>
                    <option value="重要配角" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">重要配角</option>
                    <option value="反派" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">反派</option>
                    <option value="势力首领" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">势力首领</option>
                    <option value="神秘路人" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">神秘路人</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-black mb-1">当前状态</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as CharacterStatus })}
                    className="w-full p-2 border border-[#cccccc] dark:border-neutral-700 rounded text-black dark:text-neutral-100 bg-white dark:bg-neutral-800 focus:outline-none focus:border-black dark:focus:border-neutral-400"
                  >
                    <option value="活跃" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">活跃</option>
                    <option value="重伤" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">重伤</option>
                    <option value="闭关突破" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">闭关突破</option>
                    <option value="被捕受困" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">被捕受困</option>
                    <option value="已阵亡/退出" className="bg-white text-neutral-900 dark:bg-[#1e1e22] dark:text-neutral-100">已阵亡/退出</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-black mb-1">当前功法境界/职位</label>
                  <input
                    type="text"
                    placeholder="如：金丹中期"
                    value={formData.realmOrTitle}
                    onChange={(e) => setFormData({ ...formData, realmOrTitle: e.target.value })}
                    className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-black mb-1">性格与行事准则（核心，去 AI 味必备）</label>
                <textarea
                  rows={2}
                  placeholder="详细描述其内在动机、性格缺陷及交流方式（例如：极其沉稳冷静，绝不说空话废话……）"
                  value={formData.personality}
                  onChange={(e) => setFormData({ ...formData, personality: e.target.value })}
                  className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black resize-none"
                />
              </div>

              <div>
                <label className="block font-bold text-black mb-1">外貌细节要点（支持 Show, Don't Tell 渲染）</label>
                <textarea
                  rows={2}
                  placeholder="具体描述服饰、面容特征、习惯微动作（如：右手长有一层厚茧，习惯性拂拭剑柄……）"
                  value={formData.appearance}
                  onChange={(e) => setFormData({ ...formData, appearance: e.target.value })}
                  className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black resize-none"
                />
              </div>

              <div>
                <label className="block font-bold text-black mb-1">隐藏秘辛与未揭露伏笔（自检引擎防剧透/防吃书）</label>
                <textarea
                  rows={2}
                  placeholder="仅作者与自检引擎知道的机密……"
                  value={formData.secretNotes}
                  onChange={(e) => setFormData({ ...formData, secretNotes: e.target.value })}
                  className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black resize-none"
                />
              </div>

              <div className="flex space-x-3 pt-4 border-t border-[#e5e5e5]">
                <button
                  type="submit"
                  className="bg-black text-white px-4 py-2 rounded font-bold hover:bg-neutral-800 transition-all"
                >
                  {isEditing ? '保存修改' : '保存并加入角色集'}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="bg-[#f0f0f0] text-black px-4 py-2 rounded hover:bg-[#e0e0e0] transition-all"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        ) : selectedChar ? (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start justify-between pb-4 border-b border-[#e5e5e5]">
              <div>
                <div className="flex items-center space-x-3 mb-1">
                  <h1 className="font-serif font-bold text-2xl text-black">{selectedChar.name}</h1>
                  <select
                    value={selectedChar.status}
                    onChange={(e) => handleToggleStatus(e.target.value as CharacterStatus)}
                    className={`text-xs pl-2 pr-6 py-0.5 rounded border font-medium ${getStatusStyle(selectedChar.status)} cursor-pointer transition-colors focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500`}
                    title="修改角色生存状态（改变后自检引擎会重新审计相关章节）"
                  >
                    <option value="活跃" className="bg-white text-emerald-800 dark:bg-[#1e1e22] dark:text-emerald-300 font-medium">活跃</option>
                    <option value="重伤" className="bg-white text-rose-800 dark:bg-[#1e1e22] dark:text-rose-300 font-medium">重伤</option>
                    <option value="闭关突破" className="bg-white text-neutral-700 dark:bg-[#1e1e22] dark:text-neutral-200 font-medium">闭关突破</option>
                    <option value="被捕受困" className="bg-white text-rose-800 dark:bg-[#1e1e22] dark:text-rose-300 font-medium">被捕受困</option>
                    <option value="已阵亡/退出" className="bg-white text-neutral-700 dark:bg-[#1e1e22] dark:text-neutral-200 font-medium">已阵亡/退出</option>
                  </select>
                  <span className="text-xs bg-black text-white px-2 py-0.5 rounded font-medium">
                    {selectedChar.role}
                  </span>
                </div>
                <div className="text-sm text-[#555555] font-serif">{selectedChar.alias}</div>
              </div>

              <div className="flex items-center space-x-2">
                <span className="text-xs bg-[#f5f5f5] border border-[#cccccc] text-black px-2.5 py-1 rounded flex items-center space-x-1">
                  <Award size={13} />
                  <span>{selectedChar.realmOrTitle}</span>
                </span>
                <span className="text-xs bg-[#f5f5f5] border border-[#cccccc] text-black px-2.5 py-1 rounded flex items-center space-x-1">
                  <MapPin size={13} />
                  <span>{selectedChar.currentLocation}</span>
                </span>
                <button
                  type="button"
                  onClick={startEdit}
                  className="text-xs bg-white border border-[#cccccc] text-black px-2.5 py-1 rounded flex items-center space-x-1 hover:bg-[#f0f0f0] transition-all"
                  title="编辑该角色的全部字段"
                >
                  <Pencil size={13} />
                  <span>编辑</span>
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="text-xs bg-white border border-[#e0b4b4] text-[#b71c1c] px-2.5 py-1 rounded flex items-center space-x-1 hover:bg-[#fff5f5] transition-all"
                  title="删除该角色（会清理章节出场与关系引用）"
                >
                  <Trash2 size={13} />
                  <span>删除</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
              <div className="p-4 bg-[#fafafa] border border-[#e5e5e5] rounded space-y-2">
                <div className="font-bold text-black text-sm flex items-center space-x-1.5 border-b border-[#eeeeee] pb-2">
                  <Eye size={14} className="text-black" />
                  <span>外貌与习惯动作 (Show, Don't Tell 锚点)</span>
                </div>
                <p className="text-[#333333] leading-relaxed font-serif">{selectedChar.appearance}</p>
              </div>

              <div className="p-4 bg-[#fafafa] border border-[#e5e5e5] rounded space-y-2">
                <div className="font-bold text-black text-sm flex items-center space-x-1.5 border-b border-[#eeeeee] pb-2">
                  <Heart size={14} className="text-black" />
                  <span>性格底层逻辑与行事准则</span>
                </div>
                <p className="text-[#333333] leading-relaxed font-serif">{selectedChar.personality}</p>
              </div>
            </div>

            <div className="p-4 bg-[#fafafa] border border-[#e5e5e5] rounded text-xs">
              <div className="font-bold text-black text-sm mb-2 pb-2 border-b border-[#eeeeee]">
                背景经历简述
              </div>
              <p className="text-[#333333] leading-relaxed">{selectedChar.background}</p>
            </div>

            <div className="p-4 bg-white border border-[#cccccc] rounded text-xs">
              <div className="font-bold text-black text-sm mb-3">关键关系链条（动态更新追踪图谱）</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(selectedChar.relations || []).map((rel, idx) => {
                  const target = characters.find((c) => c.id === rel.targetId);
                  return (
                    <div key={idx} className="p-2.5 bg-[#f9f9f9] border border-[#e0e0e0] rounded flex items-center justify-between">
                      <div>
                        <div className="font-bold text-black text-xs">{target ? target.name : rel.targetId}</div>
                        <div className="text-[11px] text-[#666666] mt-0.5">{rel.relation}</div>
                      </div>
                      <div className="text-right">
                        <span className={`text-xs font-mono font-bold ${rel.intimacy < 0 ? 'text-[#b71c1c]' : 'text-[#1b5e20]'}`}>
                          {rel.intimacy > 0 ? `+${rel.intimacy}` : rel.intimacy}
                        </span>
                        <div className="text-[9px] text-[#888888]">亲密/敌意度</div>
                      </div>
                    </div>
                  );
                })}
                {(selectedChar.relations || []).length === 0 && (
                  <div className="text-[#888888] py-2">暂未记录外部人物关系</div>
                )}
              </div>
            </div>

            <div className="p-4 bg-[#fefdfa] border border-[#d4a017] rounded text-xs">
              <div className="font-bold text-[#8c6b00] text-sm flex items-center space-x-1.5 mb-2">
                <ShieldAlert size={15} />
                <span>作者机密便签与伏笔红线（自检引擎防吃书校验）</span>
              </div>
              <p className="text-[#333333] leading-relaxed font-mono">{selectedChar.secretNotes}</p>
            </div>
          </div>
        ) : characters.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-[#777777]">
            <p className="text-sm">这本书还没有角色</p>
            <button
              onClick={startCreate}
              className="flex items-center space-x-1.5 bg-black text-white px-4 py-2 rounded text-xs font-medium hover:bg-neutral-800 transition-all"
            >
              <UserPlus size={14} />
              <span>新建第一个角色</span>
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
};
