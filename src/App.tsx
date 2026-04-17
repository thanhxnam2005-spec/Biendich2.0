import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import * as openpgp from 'openpgp';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { Toaster, toast } from 'sonner';
import { 
  Shield, FileText, Unlock, Download, AlertCircle, 
  RefreshCw, UploadCloud, Search, Replace, Save, 
  Library, Trash2, ChevronRight, BookOpen, X, Square,
  Scissors, FileArchive, ChevronDown, ChevronUp, ArrowRight,
  FileDown, Sparkles, Key, Settings, Headphones, Play, Pause, Volume2, Filter, Hash, Merge, Edit2, AlignLeft, Tag, Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
import * as diff from 'diff';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// Global Vietnamese Linguistics Utils
const VN_VOWELS_PLAIN = "aeiouyàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữự";

// Common Converter Phrase & Word Errors (Bypass AI entirely for these)
const COMMON_PHRASE_ERRORS: Record<string, string> = {
  // Common typo clusters
  "phụ than": "phụ thân",
  "mẫu than": "mẫu thân",
  "tinh sảo": "tinh xảo",
  "yệu thương": "yêu thương",
  "yệu đuối": "yếu đuối",
  "yệu ớt": "yếu ớt",
  "yệu kém": "yếu kém",
  "yệu nhược": "yếu nhược",
  "yệu nàng": "yêu nàng",
  "yệu thầm": "yêu thầm",
  "yệu mến": "yêu mến",
  "yệu thích": "yêu thích",
  "chỉương": "chương",
  "chỉẳng": "chẳng",
  "chỉúng": "chúng",
  "phảií": "phái",
  "pháii": "phái",
  "phát hiệnn": "phát hiện",
  "trưởngg": "trưởng",
  "chỉỉ": "chỉ",
  "vva": "và",
  "phụ tráchỉ": "phụ trách",
  "phụ tráchứ": "phụ trách",
  "thấyng": "thấy",
  "hết thảyng": "hết thảy",
  "ngơ ngácỉ": "ngơ ngác",
  "tuyệt đốií": "tuyệt đối",
  "không bướcc": "không bước",
  "tiểu tử phế vật": "tiểu tử phế vật",
  "biến hỏa": "biến hóa",
  "hoàn mỹy": "hoàn mỹ",
};

const isPossibleVietnameseWord = (word: string): boolean => {
  if (!word) return true;
  const clean = word.toLowerCase().replace(/[.,!?;:"'()]/g, '');
  if (!clean || !isNaN(Number(clean)) || clean.length <= 1) return true;
  
  // Rule 0: Double consecutive same vowels are usually invalid (except some rare cases)
  // aa, ee, ii, oo, uu, yy, iêê, uôô...
  if (/(aa|ee|ii|oo|uu|yy|ââ|ăă|êê|ôô|ơơ|ưư)/.test(clean)) return false;
  
  // Rule 1: Double consecutive same consonants at start or end
  // bbe, trưỡnng, pháii...
  if (/^([b-z])\1/i.test(clean) || /([b-z])\1$/i.test(clean)) {
    // Exception for 'ng', 'nh', etc which are clusters, but 'gg', 'nn' at end is bad
    const clusterEnds = ['ng', 'nh', 'ch'];
    const lastTwo = clean.slice(-2);
    if (lastTwo[0] === lastTwo[1] && !clusterEnds.includes(lastTwo)) return false;
  }

  const initial = "(ch|gh|gi|kh|ngh|ng|nh|ph|qu|th|tr|[bcdđghklmnpqrstvx])";
  const vowels = "[aeiouyàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữự]";
  const ending = "(ch|nh|ng|[cmnpt])";
  
  const syllableRegex = new RegExp(`^${initial}?(${vowels}+)${ending}?$`, 'i');
  
  if (syllableRegex.test(clean)) {
    // Special 'y' cluster check (y must follow specific rules)
    if (clean.startsWith('y') && clean.length > 1) {
      const standardYParts = ['yêu', 'yếm', 'yếu', 'yết', 'yên', 'yểu', 'yêu', 'yên', 'yêm'];
      if (!standardYParts.some(p => clean.includes(p))) return false;
    }
    return true;
  }
  return false;
};

interface BatchFixRule {
  id: string;
  original: string;
  replacement: string;
  type: 'fixed' | 'ambiguous';
  candidates?: string[];
}

interface AmbiguousMarker {
  id: string;
  original: string;
  contextBefore: string;
  contextAfter: string;
  fullSentence: string;
  resolvedReplacement?: string;
  method?: 'heuristic' | 'ai';
  startIndex: number;
}

interface SegmentItem {
  id: string;
  text: string;
  status: 'unknown' | 'ok' | 'err';
  suggestions?: string[];
  suspiciousWords?: string[];
}

interface SavedStory {
  id: string;
  name: string;
  content: string;
  date: string;
  genre?: string;
  description?: string;
  processedRanges?: { start: number; end: number }[];
  convertedChapters?: Record<number, string>;
  customChapterTitles?: Record<number, string>;
  commonErrors?: { o: string; n: string }[];
}

interface ConvertedViewProps {
  original: string;
  converted: string;
  showDiff: boolean;
}

const ConvertedView = React.memo(({ original, converted, showDiff }: ConvertedViewProps) => {
  const diffResult = useMemo(() => {
    if (!showDiff) return [{ value: converted }];
    return diff.diffWords(original, converted);
  }, [original, converted, showDiff]);

  return (
    <div className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap">
      {diffResult.map((part, i) => {
        if (part.removed) return null;
        return (
          <span 
            key={i} 
            className={cn(
              part.added && showDiff ? "bg-yellow-200 text-[#141414] font-bold px-0.5" : ""
            )}
          >
            {part.value}
          </span>
        );
      })}
    </div>
  );
});

ConvertedView.displayName = 'ConvertedView';

interface ChapterItemProps {
  chapter: { title: string; content: string };
  idx: number;
  story: SavedStory;
  isChapterProcessed: boolean;
  isProcessingPart: boolean;
  onChapterClick: (story: SavedStory, idx: number, title: string, content: string) => void;
  onRenameClick: (storyId: string, idx: number, title: string) => void;
  onDownload: (title: string, content: string) => void;
  onDownloadPdf: (title: string, content: string) => void;
}

const ChapterItem = React.memo(({ 
  chapter, idx, story, isChapterProcessed, isProcessingPart, 
  onChapterClick, onRenameClick, onDownload, onDownloadPdf 
}: ChapterItemProps) => {
  return (
    <div className={cn(
      "flex items-center justify-between p-2 border group/chapter transition-colors",
      isChapterProcessed 
        ? "bg-green-50 border-green-200 text-green-900" 
        : "bg-white dark:bg-[#141414] border-[#141414]/10 hover:border-[#141414] dark:border-white/10 dark:hover:border-white/40 text-[#141414] dark:text-white"
    )}>
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-1">
          <span className="text-[8px] font-mono opacity-40 uppercase">File {idx + 1}</span>
          {isChapterProcessed && <span className="text-[8px] font-mono text-green-600 font-bold uppercase">[ĐÃ XỬ LÝ]</span>}
        </div>
        <span 
          className="text-[10px] font-mono font-bold truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors" 
          onClick={() => onChapterClick(story, idx, chapter.title, chapter.content)}
        >
          {chapter.title}
        </span>
      </div>
      <div className="flex gap-1">
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={() => onChapterClick(story, idx, chapter.title, chapter.content)}
          title="Xem nội dung chương"
          className="h-7 w-7 md:opacity-0 md:group-hover/chapter:opacity-100 transition-opacity hover:bg-[#141414] hover:text-white dark:hover:bg-white dark:hover:text-[#141414] rounded-none text-current"
        >
          <BookOpen className="w-3 h-3" />
        </Button>
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={() => onRenameClick(story.id, idx, chapter.title)}
          title="Đổi tên chương"
          className="h-7 w-7 md:opacity-0 md:group-hover/chapter:opacity-100 transition-opacity hover:bg-amber-500 hover:text-white rounded-none text-current"
        >
          <Edit2 className="w-3 h-3" />
        </Button>
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={() => onDownload(chapter.title, chapter.content)}
          title="Tải file chương này (TXT)"
          className="h-7 w-7 md:opacity-0 md:group-hover/chapter:opacity-100 transition-opacity hover:bg-[#141414] hover:text-white dark:hover:bg-white dark:hover:text-[#141414] rounded-none text-current"
        >
          <Download className="w-3 h-3" />
        </Button>
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={() => onDownloadPdf(chapter.title, chapter.content)}
          title="Tải file chương này (PDF)"
          className="h-7 w-7 md:opacity-0 md:group-hover/chapter:opacity-100 transition-opacity hover:bg-red-600 hover:text-white rounded-none text-current"
        >
          <FileDown className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
});

ChapterItem.displayName = 'ChapterItem';

interface StoryItemProps {
  story: SavedStory;
  isExpanded: boolean;
  isScanningThisStory: boolean;
  isProcessingPart: boolean;
  customPrefix: string;
  isStrictMode: boolean;
  splitIntoChapters: (text: string) => { title: string; content: string }[];
  onExpand: (id: string | null) => void;
  onSplitClick: (id: string) => void;
  onExportDialog: (story: SavedStory, type: 'txt' | 'pdf' | 'docx', isConverted?: boolean) => void;
  onFilterDots: (id: string) => void;
  onRenumberDialog: (config: { isOpen: boolean; storyId: string; startNumber: number; prefix: string }) => void;
  onMergeChapters: (id: string) => void;
  onOptimizeLineBreaks: (id: string) => void;
  onApplyCommonErrors: (id: string) => void;
  onEditCommonErrors: (id: string) => void;
  onDelete: (id: string) => void;
  setCustomPrefix: (val: string) => void;
  setIsStrictMode: (val: boolean) => void;
  onChapterClick: (story: SavedStory, idx: number, title: string, content: string) => void;
  onRenameChapterClick: (storyId: string, idx: number, title: string) => void;
  onDownloadChapter: (title: string, content: string) => void;
  onDownloadChapterPdf: (title: string, content: string) => void;
  onAddToGlossary: (original: string, translated: string) => void;
}

const StoryItem = React.memo(({
  story, isExpanded, isScanningThisStory, isProcessingPart,
  customPrefix, isStrictMode, splitIntoChapters, onExpand, onSplitClick, onExportDialog,
  onFilterDots, onRenumberDialog,
  onMergeChapters, onOptimizeLineBreaks, 
  onApplyCommonErrors, onEditCommonErrors, onDelete,
  setCustomPrefix, setIsStrictMode, onChapterClick, onRenameChapterClick,
  onDownloadChapter, onDownloadChapterPdf, onAddToGlossary
}: StoryItemProps) => {
  const [localPrefix, setLocalPrefix] = useState(customPrefix);
  const [localStrict, setLocalStrict] = useState(isStrictMode);

  useEffect(() => {
    setLocalPrefix(customPrefix);
  }, [customPrefix]);

  useEffect(() => {
    setLocalStrict(isStrictMode);
  }, [isStrictMode]);

  const [showAllChapters, setShowAllChapters] = useState(false);

  const expandedChapters = useMemo(() => {
    if (!isExpanded) return [];
    const chapters = splitIntoChapters(story.content);
    if (story.customChapterTitles) {
      return chapters.map((ch, idx) => {
        const customTitle = story.customChapterTitles![idx];
        if (customTitle) {
          const lines = ch.content.split('\n');
          if (lines.length > 0) {
            lines[0] = customTitle;
          }
          return {
            ...ch,
            title: customTitle,
            content: lines.join('\n')
          };
        }
        return ch;
      });
    }
    return chapters;
  }, [isExpanded, story.content, story.customChapterTitles, splitIntoChapters]);

  return (
    <div className="hover:bg-[#141414]/5 transition-colors group">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1 cursor-pointer flex-1" onClick={() => onExpand(isExpanded ? null : story.id)}>
            <h3 className="font-mono font-bold text-sm uppercase flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {story.name}
              {isExpanded ? <ChevronUp className="w-3 h-3 opacity-40" /> : <ChevronDown className="w-3 h-3 opacity-40" />}
            </h3>
            <div className="flex items-center gap-3 mt-1">
              <p className="text-[10px] font-mono opacity-50">{story.date}</p>
              {story.genre && (
                <span className="text-[9px] font-mono bg-[#141414]/10 px-1.5 py-0.5 rounded-sm uppercase font-bold text-[#141414]/60">
                  {story.genre}
                </span>
              )}
            </div>
            {story.description && (
              <p className="text-[10px] font-mono opacity-60 italic mt-1 line-clamp-1">
                {story.description}
              </p>
            )}
            <p className="text-[10px] font-mono opacity-70 line-clamp-2 mt-2 max-w-md">
              {typeof story.content === 'string' ? (story.content.length > 0 ? story.content.substring(0, 150) : '[Nội dung trống]') : '[Lỗi dữ liệu]'}...
            </p>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onSplitClick(story.id)}
              disabled={isScanningThisStory}
              title="Xem danh sách chương"
              className="h-8 text-[10px] font-mono uppercase hover:bg-[#141414] hover:text-[#E4E3E0] rounded-none border border-[#141414]/20"
            >
              {isScanningThisStory ? (
                <RefreshCw className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <Scissors className="w-3 h-3 mr-1" />
              )}
              Tách chương
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onExportDialog(story, 'txt')}
              className="h-8 text-[10px] font-mono uppercase hover:bg-[#141414] hover:text-[#E4E3E0] rounded-none border border-[#141414]/20"
            >
              <FileText className="w-3 h-3 mr-1" /> Tải TXT
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onExportDialog(story, 'pdf')}
              className="h-8 text-[10px] font-mono uppercase hover:bg-red-600 hover:text-white rounded-none border border-red-200 text-red-600"
            >
              <FileDown className="w-3 h-3 mr-1" /> Tải PDF
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onExportDialog(story, 'docx')}
              className="h-8 text-[10px] font-mono uppercase hover:bg-blue-600 hover:text-white rounded-none border border-blue-200 text-blue-600"
            >
              <FileText className="w-3 h-3 mr-1" /> Tải WORD
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onFilterDots(story.id)}
              className="h-8 text-[10px] font-mono uppercase hover:bg-emerald-500 hover:text-white rounded-none border border-emerald-200 text-emerald-600"
            >
              <Filter className="w-3 h-3 mr-1" /> Lọc dấu (.)
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onRenumberDialog({ isOpen: true, storyId: story.id, startNumber: 1, prefix: 'Chương' })}
              className="h-8 text-[10px] font-mono uppercase hover:bg-indigo-500 hover:text-white rounded-none border border-indigo-200 text-indigo-600"
            >
              <Hash className="w-3 h-3 mr-1" /> Đánh số lại
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onMergeChapters(story.id)}
              className="h-8 text-[10px] font-mono uppercase hover:bg-orange-500 hover:text-white rounded-none border border-orange-200 text-orange-600"
            >
              <Merge className="w-3 h-3 mr-1" /> Gộp chương (-))
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onOptimizeLineBreaks(story.id)}
              className="h-8 text-[10px] font-mono uppercase hover:bg-cyan-500 hover:text-white rounded-none border border-cyan-200 text-cyan-600"
            >
              <AlignLeft className="w-3 h-3 mr-1" /> Tối ưu xuống dòng
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => onDelete(story.id)}
              className="h-8 text-[10px] font-mono uppercase hover:bg-red-500 hover:text-white rounded-none border border-red-200 text-red-500"
            >
              <Trash2 className="w-3 h-3 mr-1" /> Xoá
            </Button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="bg-[#141414]/5 border-t border-[#141414]/10"
          >
            <div className="p-4 space-y-4">
              {/* Metadata Section */}
              {(story.genre || story.description || (story.convertedChapters && Object.keys(story.convertedChapters).length > 0)) && (
                <div className="bg-white border border-[#141414]/10 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase opacity-40">
                      <BookOpen className="w-3 h-3" />
                      Thông tin chi tiết
                    </div>
                    {story.convertedChapters && Object.keys(story.convertedChapters).length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono uppercase text-green-600 font-bold bg-green-50 px-2 py-0.5 border border-green-100">Đã biên dịch AI</span>
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          onClick={() => onExportDialog(story, 'txt', true)}
                          className="h-6 text-[8px] font-mono uppercase hover:bg-green-600 hover:text-white rounded-none border border-green-200 text-green-600"
                        >
                          Tải TXT Dịch
                        </Button>
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          onClick={() => onExportDialog(story, 'pdf', true)}
                          className="h-6 text-[8px] font-mono uppercase hover:bg-red-600 hover:text-white rounded-none border border-red-200 text-red-600"
                        >
                          Tải PDF Dịch
                        </Button>
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          onClick={() => onExportDialog(story, 'docx', true)}
                          className="h-6 text-[8px] font-mono uppercase hover:bg-blue-600 hover:text-white rounded-none border border-blue-200 text-blue-600"
                        >
                          Tải WORD Dịch
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {story.genre && (
                      <div className="space-y-1">
                        <Label className="text-[9px] font-mono uppercase opacity-50">Thể loại</Label>
                        <p className="text-xs font-mono font-bold">{story.genre}</p>
                      </div>
                    )}
                    {story.description && (
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-[9px] font-mono uppercase opacity-50">Giới thiệu</Label>
                        <p className="text-xs font-mono leading-relaxed">{story.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Custom Split Config */}
              <div className="bg-white border border-[#141414]/10 p-3 space-y-2">
                <Label className="text-[10px] font-mono uppercase opacity-50">Cấu hình từ khóa tách chương (Nếu AI không tự nhận diện được)</Label>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-[200px]">
                    <Input 
                      placeholder="Ví dụ: 'Bài' hoặc 'Câu'..."
                      value={localPrefix}
                      onChange={(e) => setLocalPrefix(e.target.value)}
                      className="h-8 text-xs border-[#141414]/20 rounded-none font-mono"
                    />
                  </div>
                  <div className="flex items-center gap-2 bg-white px-3 py-1 border border-[#141414]/10">
                    <input 
                      type="checkbox" 
                      id={`strict-mode-${story.id}`}
                      checked={localStrict}
                      onChange={(e) => setLocalStrict(e.target.checked)}
                      className="w-3 h-3 accent-[#141414]"
                    />
                    <Label htmlFor={`strict-mode-${story.id}`} className="text-[9px] font-mono uppercase cursor-pointer">Chế độ nghiêm ngặt (Tránh tách nhầm)</Label>
                  </div>
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => {
                      setCustomPrefix(localPrefix);
                      setIsStrictMode(localStrict);
                      onExpand(null);
                      setTimeout(() => onExpand(story.id), 50);
                    }}
                    className="h-8 text-[10px] font-mono uppercase border-[#141414] rounded-none px-4"
                  >
                    Áp dụng
                  </Button>
                </div>
                <p className="text-[9px] font-mono opacity-40">Mặc định đã hỗ trợ: Chương, Hồi, Quyển, Tiết, Thứ, Số, Phần, Tập...</p>
              </div>

              {/* Common Errors Dictionary */}
              <div className="bg-white border border-[#141414]/10 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase opacity-40">
                    <Tag className="w-3 h-3" />
                    Từ điển lỗi hệ thống (Lọc & Sửa nhanh)
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      size="sm" 
                      variant="outline"
                      onClick={() => onEditCommonErrors(story.id)}
                      className="h-7 text-[9px] font-mono uppercase border-[#141414]/20 hover:bg-blue-50 text-blue-600"
                    >
                      <Edit2 className="w-3 h-3 mr-1" />
                      Chỉnh sửa thủ công
                    </Button>
                    <Button 
                      size="sm" 
                      onClick={() => onApplyCommonErrors(story.id)}
                      disabled={!story.commonErrors || story.commonErrors.length === 0}
                      className="h-7 text-[9px] font-mono uppercase bg-emerald-600 hover:bg-emerald-700 text-white rounded-none"
                    >
                      <Zap className="w-3 h-3 mr-1" />
                      Sửa lỗi toàn truyện
                    </Button>
                  </div>
                </div>

                {story.commonErrors && story.commonErrors.length > 0 ? (
                  <div className="flex flex-wrap gap-2 max-h-[150px] overflow-y-auto p-2 bg-[#141414]/5 border border-dashed border-[#141414]/10">
                    <div className="w-full flex justify-between items-center mb-1">
                      <span className="text-[9px] font-mono opacity-60 uppercase font-bold">Danh sách lỗi AI đã quét:</span>
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        className="h-5 text-[8px] font-mono uppercase bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2"
                        onClick={() => {
                          story.commonErrors?.forEach(err => onAddToGlossary(err.o, err.n));
                          toast.success("Đã thêm tất cả vào từ điển chung!");
                        }}
                      >
                        <Library className="w-2 h-2 mr-1" /> Thêm tất cả vào từ điển
                      </Button>
                    </div>
                    {story.commonErrors.map((err, i) => (
                      <div key={i} className="flex items-center gap-1 bg-white border border-[#141414]/10 px-2 py-1 rounded-sm shadow-sm group/err">
                        <span className="text-[10px] font-mono line-through opacity-40">{err.o}</span>
                        <ArrowRight className="w-2 h-2 opacity-20" />
                        <span className="text-[10px] font-mono font-bold text-emerald-600">{err.n}</span>
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-4 w-4 ml-1 opacity-0 group-hover/err:opacity-100 transition-opacity hover:bg-emerald-100"
                          onClick={() => {
                            onAddToGlossary(err.o, err.n);
                            toast.success(`Đã thêm "${err.o}" vào từ điển!`);
                          }}
                          title="Thêm vào từ điển chung"
                        >
                          <Library className="w-2 h-2 text-emerald-600" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4 border border-dashed border-[#141414]/10">
                    <p className="text-[9px] font-mono opacity-40 italic">Chưa có danh sách lỗi hệ thống. Hãy nhấn "Chỉnh sửa thủ công" để thêm các lỗi lặp lại (ví dụ: sai OCR, sai tên nhân vật...).</p>
                  </div>
                )}
                <p className="text-[8px] font-mono opacity-50 italic">Mẹo: Sau khi AI quét xong, bạn có thể nhấn "Sửa lỗi toàn truyện" để thay thế hàng loạt mà không tốn thêm token.</p>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#141414] text-[#E4E3E0] p-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Scissors className="w-5 h-5" />
                    <motion.div 
                      animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 bg-white rounded-full -z-10"
                    />
                  </div>
                  <div>
                    <h4 className="text-[11px] font-mono font-bold uppercase">
                      AI ĐÃ QUÉT & TÁCH THÀNH {expandedChapters.length} CHƯƠNG
                    </h4>
                    <p className="text-[9px] font-mono opacity-60">Chọn chương để tải lẻ hoặc xem nội dung</p>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {(showAllChapters ? expandedChapters : expandedChapters.slice(0, 50)).map((chapter, idx) => {
                  const displayTitle = chapter.title || `Chương ${idx + 1}`;
                  const isChapterProcessed = story.processedRanges?.some(r => 
                    (r.start === idx && r.end === idx + 1) || 
                    (idx >= r.start && idx < r.end)
                  );
                  
                  return (
                    <ChapterItem 
                      key={`${story.id}-ch-${idx}-${displayTitle}-${chapter.content.length}`}
                      chapter={{...chapter, title: displayTitle}}
                      idx={idx}
                      story={story}
                      isChapterProcessed={!!isChapterProcessed}
                      isProcessingPart={isProcessingPart}
                      onChapterClick={onChapterClick}
                      onRenameClick={onRenameChapterClick}
                      onDownload={onDownloadChapter}
                      onDownloadPdf={onDownloadChapterPdf}
                    />
                  );
                })}
              </div>

              {!showAllChapters && expandedChapters.length > 50 && (
                <div className="flex justify-center pt-2">
                  <Button 
                    variant="outline" 
                    onClick={() => setShowAllChapters(true)}
                    className="font-mono text-[10px] uppercase border-[#141414] rounded-none px-8"
                  >
                    Xem thêm {expandedChapters.length - 50} chương còn lại
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

StoryItem.displayName = 'StoryItem';

interface AudioChunk {
  id: number;
  text: string;
  audioUrl: string | null;
  status: 'pending' | 'generating' | 'ready' | 'error';
}

function useEvent<T extends (...args: any[]) => any>(handler: T): T {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Parameters<T>) => {
    const fn = handlerRef.current;
    return fn(...args);
  }, []) as T;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Batch Fix States
  const [batchInput, setBatchInput] = useState('');
  const [batchOutput, setBatchOutput] = useState('');
  const [batchRules, setBatchRules] = useState<BatchFixRule[]>([
    { id: '1', original: 'thỳ', replacement: 'thì', type: 'fixed' },
    { id: '2', original: 'ko', replacement: 'không', type: 'fixed' },
    { id: '3', original: 'đc', replacement: 'được', type: 'fixed' },
    { id: '4', original: 'yệu', replacement: 'yếu', type: 'ambiguous', candidates: ['yêu', 'yếu'] },
  ]);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [batchStats, setBatchStats] = useState({ fixed: 0, ambiguous: 0, ai: 0 });
  const [showConfig, setShowConfig] = useState(true);
  const [useAIForAmbiguous, setUseAIForAmbiguous] = useState(false);
  const [useDeepClean, setUseDeepClean] = useState(false); // New: Direct AI proofreading in chunks
  const [normalizePunc, setNormalizePunc] = useState(true);
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [uniqueWordAnalysis, setUniqueWordAnalysis] = useState<{ word: string, count: number, isSuspicious: boolean }[]>([]);
  const [isAnalyzingWords, setIsAnalyzingWords] = useState(false);
  const [ambiguousMarkers, setAmbiguousMarkers] = useState<AmbiguousMarker[]>([]);
  const [activeBatchStep, setActiveBatchStep] = useState<'input' | 'processing' | 'review' | 'result' | 'segments'>('input');
  const [segments, setSegments] = useState<SegmentItem[]>([]);
  const [newRule, setNewRule] = useState({ original: '', replacement: '', type: 'fixed' as const });
  const [selectedStoryId, setSelectedStoryId] = useState<string>('');
  const [selectedChaptersRange, setSelectedChaptersRange] = useState<string>('all');
  const [isDragging, setIsDragging] = useState(false);
  
  // Find and Replace state
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  
  // Library state
  const [library, setLibrary] = useState<SavedStory[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('decrypt');
  const [selectedConvertStoryId, setSelectedConvertStoryId] = useState<string | null>(null);
  const [selectedConvertChapterIdx, setSelectedConvertChapterIdx] = useState<number | null>(null);
  const [expandedStoryId, setExpandedStoryId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<string | null>(null);
  const [editErrorsDialog, setEditErrorsDialog] = useState<{ isOpen: boolean; storyId: string; rawText: string }>({ isOpen: false, storyId: '', rawText: '' });
  const [pdfDownloadProgress, setPdfDownloadProgress] = useState<{ current: number, total: number } | null>(null);
  const [fontBase64, setFontBase64] = useState<string | null>(null);
  const [customPrefix, setCustomPrefix] = useState<string>('');
  const [isStrictMode, setIsStrictMode] = useState<boolean>(true);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState<boolean>(true);

  const GENRE_OPTIONS = ["Tu Tiên", "Huyền Huyễn", "Đô Thị", "Khoa Huyễn", "Võ Hiệp", "Tiên Hiệp", "Linh Dị", "Dã Sử"];
  const STYLE_OPTIONS = ["Huyễn Tưởng Tu Tiên", "Đông Phương Huyền Huyễn", "Hiện Đại Đô Thị", "Cổ Đại Võ Hiệp", "Linh Dị Thần Quái"];

  const toggleGenre = (genre: string) => {
    setSelectedGenres(prev => 
      prev.includes(genre) ? prev.filter(g => g !== genre) : [...prev, genre]
    );
  };

  const toggleStyle = (style: string) => {
    setSelectedStyles(prev => 
      prev.includes(style) ? prev.filter(s => s !== style) : [...prev, style]
    );
  };
  
  // Google Drive state
  const [isFixingAI, setIsFixingAI] = useState(false);
  
  const [saveStoryDialog, setSaveStoryDialog] = useState<{
    isOpen: boolean;
    name: string;
    genre: string;
    description: string;
    content: string;
    isGenerating?: boolean;
    commonErrors?: {o: string, n: string}[];
  }>({ isOpen: false, name: '', genre: '', description: '', content: '', isGenerating: false });

  const [aiProgress, setAiProgress] = useState(0);
  const [testChapterCount, setTestChapterCount] = useState(1);
  const [selectedPart, setSelectedPart] = useState<number>(0);
  const [isProcessingPart, setIsProcessingPart] = useState(false);
  const [partProgress, setPartProgress] = useState(0);
  const [isAutoConverting, setIsAutoConvertingState] = useState(false);
  const [skipChaptersCount, setSkipChaptersCount] = useState(0);
  const [translationMode, setTranslationMode] = useState<'quality' | 'fast' | 'proofread'>('quality');
  const [concurrency, setConcurrency] = useState(1);
  const isAutoConvertingRef = React.useRef(false);
  
  const [exportDialog, setExportDialog] = useState<{
    isOpen: boolean;
    story: SavedStory | null;
    type: 'txt' | 'pdf' | 'docx';
    chapters: { title: string, content: string }[];
    startChapter: string;
    endChapter: string;
    isConverted?: boolean;
  }>({ isOpen: false, story: null, type: 'txt', chapters: [], startChapter: '1', endChapter: '100', isConverted: false });

  const [viewChapterDialog, setViewChapterDialog] = useState<{
    isOpen: boolean;
    story: SavedStory | null;
    chapterIdx: number;
    content: string;
    title: string;
  }>({ isOpen: false, story: null, chapterIdx: 0, content: '', title: '' });

  const [renameChapterDialog, setRenameChapterDialog] = useState<{
    isOpen: boolean;
    storyId: string | null;
    chapterIdx: number;
    oldTitle: string;
    newTitle: string;
  }>({
    isOpen: false,
    storyId: null,
    chapterIdx: -1,
    oldTitle: '',
    newTitle: '',
  });

  const [renumberDialog, setRenumberDialog] = useState<{
    isOpen: boolean;
    storyId: string | null;
    startNumber: number;
    prefix: string;
  }>({
    isOpen: false,
    storyId: null,
    startNumber: 1,
    prefix: 'Chương'
  });





  const handleChapterClick = (story: SavedStory, idx: number, title: string, content: string) => {
    setViewChapterDialog({
      isOpen: true,
      story,
      chapterIdx: idx,
      content,
      title,
      isFixing: false,
      fixedContent: undefined
    });
  };


  const setIsAutoConverting = (value: boolean) => {
    setIsAutoConvertingState(value);
    isAutoConvertingRef.current = value;
  };
  
  const stopAutoConversion = () => {
    setIsAutoConverting(false);
    setIsProcessingPart(false);
    toast.info("Đã dừng dịch tự động.");
  };

  const splitTextForAudio = (text: string, maxLength = 1500) => {
    const chunks: string[] = [];
    const paragraphs = text.split('\n');
    let currentChunk = '';

    for (const p of paragraphs) {
      if (!p.trim()) continue;
      if (currentChunk.length + p.length > maxLength && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      currentChunk += p + '\n';
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    return chunks;
  };

  // API Key state
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [currentKeyIndexState, setCurrentKeyIndexState] = useState(0);
  const currentKeyIndexRef = React.useRef(0);
  
  const setCurrentKeyIndex = (index: number) => {
    setCurrentKeyIndexState(index);
    currentKeyIndexRef.current = index;
  };
  
  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [availableGeminiModels, setAvailableGeminiModels] = useState<string[]>(['gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-flash-latest']);
  const [isScanningModels, setIsScanningModels] = useState(false);

  const scanGeminiModels = async (key: string) => {
    if (!key) {
      toast.error("Vui lòng nhập API Key trước khi quét");
      return;
    }
    setIsScanningModels(true);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      const data = await response.json();
      if (data.models) {
        const models = data.models.map((m: any) => m.name.replace('models/', '')).filter((m: string) => m.includes('gemini'));
        setAvailableGeminiModels(models);
        toast.success(`Đã tìm thấy ${models.length} models`);
      } else {
        toast.error("Không thể lấy danh sách model");
      }
    } catch (error) {
      toast.error("Lỗi khi quét model: " + (error as Error).message);
    } finally {
      setIsScanningModels(false);
    }
  };

  const addGeminiKey = () => {
    if (!newGeminiKey.trim()) return;
    const key = newGeminiKey.trim();
    if (!apiKeys.includes(key)) {
      const newKeys = [...apiKeys, key];
      setApiKeys(newKeys);
      setNewGeminiKey('');
      toast.success("Đã thêm API Key");
    } else {
      toast.error("API Key đã tồn tại");
    }
  };
  
  const [openRouterKeys, setOpenRouterKeys] = useState<string[]>([]);
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [aiProvider, setAiProvider] = useState<'gemini' | 'openrouter'>('gemini');
  const [openRouterModel, setOpenRouterModel] = useState('google/gemini-2.0-flash-lite-preview-02-05:free');
  const [geminiModel, setGeminiModel] = useState('gemini-3-flash-preview');
  const [disabledKeys, setDisabledKeys] = useState<string[]>([]);
  const [glossary, setGlossary] = useState<{ original: string, translated: string }[]>([]);
  const [storyContext, setStoryContext] = useState('');
  
  const [showApiKeySettings, setShowApiKeySettings] = useState(false);
  const [keyBalances, setKeyBalances] = useState<Record<string, string>>({});
  const [isCheckingBalance, setIsCheckingBalance] = useState(false);
  const [keyStatuses, setKeyStatuses] = useState<Record<string, { status: 'success' | 'error' | 'testing', message: string }>>({});

  const testApiKey = async (key: string, provider: 'gemini' | 'openrouter') => {
    setKeyStatuses(prev => ({ ...prev, [key]: { status: 'testing', message: 'Đang kiểm tra...' } }));
    
    try {
      if (provider === 'gemini') {
        const genAI = new GoogleGenAI({ apiKey: key });
        const result = await genAI.models.generateContent({
          model: geminiModel,
          contents: "Viết một đoạn văn ngắn khoảng 50 từ.",
          config: {
            maxOutputTokens: 100
          }
        });
        if (result.text) {
          setKeyStatuses(prev => ({ ...prev, [key]: { status: 'success', message: 'Hoạt động tốt' } }));
          toast.success(`Key Gemini hoạt động!`);
        }
      } else {
        const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { "Authorization": `Bearer ${key}` }
        });
        const data = await response.json();
        if (response.ok) {
          const usage = data.data?.usage?.toFixed(4) || '0.0000';
          const limit = data.data?.limit?.toFixed(2) || '?';
          setKeyStatuses(prev => ({ ...prev, [key]: { status: 'success', message: `OK - Dùng: $${usage}/$${limit}` } }));
          toast.success(`Key OpenRouter hoạt động!`);
        } else {
          const errorMsg = data.error?.message || "Key không hợp lệ";
          setKeyStatuses(prev => ({ ...prev, [key]: { status: 'error', message: errorMsg } }));
          toast.error(`Lỗi Key: ${errorMsg}`);
        }
      }
    } catch (err: any) {
      console.error("API Key test failed", err);
      let errorMsg = err.message || "Lỗi kết nối";
      if (errorMsg.includes("API_KEY_INVALID")) errorMsg = "Key không hợp lệ (Sai định dạng)";
      if (errorMsg.includes("429")) errorMsg = "Hết hạn mức (Rate Limit)";
      if (errorMsg.includes("quota")) errorMsg = "Hết hạn mức (Quota)";
      
      setKeyStatuses(prev => ({ ...prev, [key]: { status: 'error', message: errorMsg } }));
      toast.error(`Lỗi: ${errorMsg}`);
    }
  };

  const [dailyTokens, setDailyTokens] = useState(0);

  // Load daily tokens from localStorage
  useEffect(() => {
    const today = new Date().toDateString();
    const storedDate = window.localStorage.getItem('gpg_usage_date');
    const storedTokens = window.localStorage.getItem('gpg_daily_tokens');

    if (storedDate === today && storedTokens) {
      setDailyTokens(parseInt(storedTokens));
    } else {
      window.localStorage.setItem('gpg_usage_date', today);
      window.localStorage.setItem('gpg_daily_tokens', '0');
      setDailyTokens(0);
    }
  }, []);

  const updateDailyTokens = (tokens: number) => {
    setDailyTokens(prev => {
      const newVal = prev + tokens;
      window.localStorage.setItem('gpg_daily_tokens', newVal.toString());
      return newVal;
    });
  };

  const checkApiKeyBalances = async () => {
    setIsCheckingBalance(true);
    const balances: Record<string, string> = {};
    
    for (const key of openRouterKeys) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { "Authorization": `Bearer ${key}` }
        });
        if (response.ok) {
          const data = await response.json();
          balances[key] = `$${data.data?.usage?.toFixed(4) || '0.0000'} / $${data.data?.limit?.toFixed(2) || '?'}`;
        } else {
          balances[key] = "Lỗi / Hết hạn";
        }
      } catch {
        balances[key] = "Không thể kết nối";
      }
    }
    setKeyBalances(balances);
    setIsCheckingBalance(false);
    toast.success("Đã cập nhật số dư API");
  };

  // Initialize IndexedDB
  const initDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('GPG_Decryptor_DB', 1);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('library')) {
          db.createObjectStore('library', { keyPath: 'id' });
        }
      };
      request.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
      request.onerror = (event) => reject((event.target as IDBOpenDBRequest).error);
    });
  };

  const saveToIndexedDB = async (data: SavedStory[]) => {
    try {
      const db = await initDB();
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('library', 'readwrite');
        const store = transaction.objectStore('library');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        
        store.clear();
        for (const story of data) {
          store.add(story);
        }
      });
    } catch (e) {
      console.error('Failed to save to IndexedDB', e);
      throw e;
    }
  };

  const loadFromIndexedDB = async (): Promise<SavedStory[]> => {
    try {
      const db = await initDB();
      const transaction = db.transaction('library', 'readonly');
      const store = transaction.objectStore('library');
      return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      console.error('Failed to load from IndexedDB', e);
      return [];
    }
  };

  // Load library from storage on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLibraryLoading(true);
      try {
        // Try IndexedDB first
        const dbData = await loadFromIndexedDB();
        if (dbData.length > 0) {
          setLibrary(dbData.sort((a, b) => {
            // Sort by date descending
            try {
              const dateA = new Date(a.date.split(' ').reverse().join(' ')).getTime();
              const dateB = new Date(b.date.split(' ').reverse().join(' ')).getTime();
              return dateB - dateA;
            } catch (err) {
              return 0;
            }
          }));
        } else {
          // Fallback to localStorage for migration
          const localData = window.localStorage.getItem('gpg_library');
          if (localData) {
            const parsed = JSON.parse(localData);
            if (Array.isArray(parsed)) {
              setLibrary(parsed);
              // Migrate to IndexedDB
              await saveToIndexedDB(parsed);
            }
          }
        }
      } catch (e) {
        console.error('Library loading failed', e);
      } finally {
        setIsLibraryLoading(false);
      }
    };
    loadData();

    // Load API Keys
    try {
      const savedKeys = window.localStorage.getItem('gpg_api_keys');
      if (savedKeys) {
        const parsed = JSON.parse(savedKeys);
        if (Array.isArray(parsed)) {
          setApiKeys(parsed);
        }
      }
      
      const savedORKeys = window.localStorage.getItem('gpg_openrouter_keys');
      if (savedORKeys) {
        const parsed = JSON.parse(savedORKeys);
        if (Array.isArray(parsed)) {
          setOpenRouterKeys(parsed);
          setOpenRouterKeyInput(parsed.join('\n'));
        }
      }
      
      const savedProvider = window.localStorage.getItem('gpg_ai_provider');
      if (savedProvider === 'gemini' || savedProvider === 'openrouter') {
        setAiProvider(savedProvider);
      }
      
      const savedModel = window.localStorage.getItem('gpg_openrouter_model');
      if (savedModel) {
        setOpenRouterModel(savedModel);
      }

      const savedGeminiModel = window.localStorage.getItem('gpg_gemini_model');
      if (savedGeminiModel) {
        setGeminiModel(savedGeminiModel);
      }

      const savedAvailableModels = window.localStorage.getItem('gpg_available_gemini_models');
      if (savedAvailableModels) {
        try {
          const parsed = JSON.parse(savedAvailableModels);
          if (Array.isArray(parsed)) {
            setAvailableGeminiModels(parsed);
          }
        } catch (e) {
          console.warn('Failed to parse available models', e);
        }
      }

      const savedDisabledKeys = window.localStorage.getItem('gpg_disabled_keys');
      if (savedDisabledKeys) {
        setDisabledKeys(JSON.parse(savedDisabledKeys));
      }

      const savedGlossary = window.localStorage.getItem('gpg_glossary');
      if (savedGlossary) {
        setGlossary(JSON.parse(savedGlossary));
      }

      const savedContext = window.localStorage.getItem('gpg_story_context');
      if (savedContext) {
        setStoryContext(savedContext);
      }
      const savedGenres = window.localStorage.getItem('gpg_selected_genres');
      if (savedGenres) {
        setSelectedGenres(JSON.parse(savedGenres));
      }

      const savedStyles = window.localStorage.getItem('gpg_selected_styles');
      if (savedStyles) {
        setSelectedStyles(JSON.parse(savedStyles));
      }
    } catch (e) {
      console.warn('Failed to load API keys', e);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('gpg_selected_genres', JSON.stringify(selectedGenres));
  }, [selectedGenres]);

  useEffect(() => {
    window.localStorage.setItem('gpg_selected_styles', JSON.stringify(selectedStyles));
  }, [selectedStyles]);

  const handleAddToGlossary = useCallback((original: string, translated: string) => {
    setGlossary(prev => {
      // Check if already exists
      const exists = prev.some(item => item.original === original);
      if (exists) {
        return prev.map(item => item.original === original ? { original, translated } : item);
      }
      return [...prev, { original, translated }];
    });
  }, []);

  // Load font for fast PDF generation
  useEffect(() => {
    const loadFont = async () => {
      try {
        // Using a reliable CDN for Roboto-Regular.ttf
        const response = await fetch('https://raw.githubusercontent.com/googlefonts/roboto/master/src/hinted/Roboto-Regular.ttf');
        if (!response.ok) throw new Error('Font fetch failed');
        const arrayBuffer = await response.arrayBuffer();
        
        // Convert arrayBuffer to base64
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = window.btoa(binary);
        setFontBase64(base64);
      } catch (err) {
        console.error('Failed to load font for PDF', err);
      }
    };
    loadFont();
  }, []);

  const splitIntoChapters = useCallback((text: string) => {
    if (!text || typeof text !== 'string') return [];
    
    // Comprehensive regex for Vietnamese story chapters
    const defaultPrefixes = "Chương|Hồi|Quyển|Tiết|Thứ|Số|Phần|Tập|Lớp|Trận|Bảng|Cấp|Hạng|Khóa|Trang";
    const prefixes = customPrefix ? `${defaultPrefixes}|${customPrefix}` : defaultPrefixes;
    
    // In Strict Mode, we require the marker to be at the start of a line
    // and followed by a number or Roman numeral more strictly.
    // We also avoid matching "Thứ" if it's followed by "hai, ba, tư..." unless it's clearly a title.
    const pattern = isStrictMode 
      ? `^[ \\t]*(${prefixes})\\s+(\\d+|[IVXLCDM]+)(?::| -|\\.| |\\n|$)`
      : `^[ \\t]*(${prefixes})\\s*(\\d+|[IVXLCDM]+|[\\w\\d\\s]+)(?::| -|\\.| |\\n|$)`;
      
    const chapterRegex = new RegExp(pattern, "gim");
    const chapters: { title: string; content: string }[] = [];
    
    // To further prevent false positives, we'll filter matches that look like sentences
    const allMatches = Array.from(text.matchAll(chapterRegex));
    const filteredMatches = allMatches.filter(match => {
      if (!isStrictMode) return true;
      
      // Check the line content - chapter titles are usually short
      const lineEndIndex = text.indexOf('\n', match.index);
      const lineContent = text.substring(match.index!, lineEndIndex === -1 ? text.length : lineEndIndex).trim();
      
      // If the line is too long, it's probably a sentence, not a title
      if (lineContent.length > 150) return false;
      
      // Specific check for "Thứ" to avoid days of week in sentences
      if (match[1].toLowerCase() === 'thứ') {
        const afterPrefix = match[2].toLowerCase().trim();
        const daysOfWeek = ['hai', 'ba', 'tư', 'năm', 'sáu', 'bảy', 'bẩy'];
        if (daysOfWeek.includes(afterPrefix) && lineContent.length > 20) {
          return false; // Likely "Thứ hai tôi đi học..."
        }
      }
      
      return true;
    });
    
    if (filteredMatches.length === 0) {
      return [{ title: "Toàn bộ nội dung", content: text }];
    }

    for (let i = 0; i < filteredMatches.length; i++) {
      const match = filteredMatches[i];
      const nextMatch = filteredMatches[i + 1];
      
      const start = match.index!;
      const end = nextMatch ? nextMatch.index : text.length;
      
      if (i === 0 && start > 0) {
        const intro = text.substring(0, start).trim();
        if (intro) {
          chapters.push({ title: "Phần mở đầu", content: intro });
        }
      }

      const lineEndIndex = text.indexOf('\n', start);
      const titleEnd = lineEndIndex === -1 ? end : Math.min(lineEndIndex, end);
      let fullTitle = text.substring(start, titleEnd).trim();
      
      // If the title is too long (e.g., the chapter marker is just the start of a long paragraph),
      // fallback to just the marker.
      if (fullTitle.length > 200) {
        fullTitle = match[0].trim().replace(/\n/g, ' ');
      }

      chapters.push({
        title: fullTitle,
        content: text.substring(start, end).trim()
      });
    }

    return chapters;
  }, [customPrefix, isStrictMode]);

  // Memoized chapters for the currently selected story in Convert tab
  const currentConvertStory = useMemo(() => {
    return library.find(s => s.id === selectedConvertStoryId);
  }, [library, selectedConvertStoryId]);

  const currentConvertChapters = useMemo(() => {
    if (!currentConvertStory) return [];
    return splitIntoChapters(currentConvertStory.content);
  }, [currentConvertStory, splitIntoChapters]);

  const downloadAsZip = async (story: SavedStory) => {
    const chapters = splitIntoChapters(story.content);
    const zip = new JSZip();
    
    chapters.forEach((ch, index) => {
      const fileName = `${(index + 1).toString().padStart(3, '0')}_${ch.title.replace(/[\\/:*?"<>|]/g, '_')}.txt`;
      zip.file(fileName, ch.content);
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${story.name}_chapters.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const generatePdfBlob = async (title: string, content: string) => {
    const doc = new jsPDF({
      orientation: 'p',
      unit: 'mm',
      format: 'a4',
      compress: true
    });

    // If font is loaded, use it for proper Vietnamese support
    if (fontBase64) {
      try {
        doc.addFileToVFS('Roboto-Regular.ttf', fontBase64);
        doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal', 'Identity-H');
        doc.setFont('Roboto');
      } catch (e) {
        console.error('Error adding font to PDF, falling back to standard font', e);
        doc.setFont('helvetica');
      }
    } else {
      doc.setFont('helvetica');
    }

    // Set title
    doc.setFontSize(22);
    try {
      doc.text(title, 15, 20);
    } catch (e) {
      // Fallback if title has unsupported chars for current font
      doc.setFont('helvetica');
      doc.text(title.normalize('NFD').replace(/[\u0300-\u036f]/g, ""), 15, 20);
    }
    
    doc.setLineWidth(0.5);
    doc.line(15, 25, 195, 25);
    
    // Set content
    doc.setFontSize(11);
    const splitText = doc.splitTextToSize(content, 180);
    
    // Handle pagination
    let cursorY = 35;
    const pageHeight = doc.internal.pageSize.getHeight();
    
    splitText.forEach((line: string) => {
      if (cursorY > pageHeight - 15) {
        doc.addPage();
        cursorY = 20;
      }
      try {
        doc.text(line, 15, cursorY);
      } catch (e) {
        // If text rendering fails, try to render without accents as a last resort
        const safeLine = line.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
        doc.text(safeLine, 15, cursorY);
      }
      cursorY += 6;
    });
    
    return doc.output('blob');
  };

  const generateDocxBlob = async (title: string, content: string) => {
    const paragraphs = content.split('\n').map(line => {
      const trimmed = line.trim();
      return new Paragraph({
        children: [
          new TextRun({
            text: trimmed,
            size: 24, // 12pt
          }),
        ],
        spacing: {
          after: 200,
        },
      });
    });

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              text: title,
              heading: HeadingLevel.HEADING_1,
              alignment: AlignmentType.CENTER,
              spacing: {
                after: 400,
              },
            }),
            ...paragraphs,
          ],
        },
      ],
    });

    return await Packer.toBlob(doc);
  };

  const downloadChapterAsPdf = async (title: string, content: string) => {
    try {
      const blob = await generatePdfBlob(title, content);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF generation failed', err);
      setError('Không thể tạo file PDF. Vui lòng thử lại.');
    }
  };

  const openExportDialog = (story: SavedStory, type: 'txt' | 'pdf' | 'docx', isConverted: boolean = false) => {
    let chapters = splitIntoChapters(story.content);
    
    if (story.customChapterTitles) {
      chapters = chapters.map((ch, idx) => {
        const customTitle = story.customChapterTitles![idx];
        if (customTitle) {
          const lines = ch.content.split('\n');
          if (lines.length > 0) {
            lines[0] = customTitle;
          }
          return {
            ...ch,
            title: customTitle,
            content: lines.join('\n')
          };
        }
        return ch;
      });
    }
    
    // If exporting converted content, filter to only include converted chapters
    if (isConverted) {
      if (!story.convertedChapters || Object.keys(story.convertedChapters).length === 0) {
        toast.error("Chưa có chương nào được biên dịch AI.");
        return;
      }

      chapters = chapters.map((ch, idx) => ({
        ...ch,
        content: story.convertedChapters?.[idx] || "", // Use empty string if not converted
        isConverted: !!story.convertedChapters?.[idx],
        originalIdx: idx
      }));
    }

    setExportDialog({
      isOpen: true,
      story,
      type,
      chapters,
      startChapter: '1',
      endChapter: chapters.length.toString(),
      isConverted
    });
  };

  const handleExport = async (scope: 'all' | 'range', format: 'zip' | 'single') => {
    const { story, type, chapters, startChapter, endChapter, isConverted } = exportDialog;
    if (!story) return;

    let startIdx = 0;
    let endIdx = chapters.length;

    if (scope === 'range') {
      startIdx = Math.max(0, parseInt(startChapter) - 1);
      endIdx = Math.min(chapters.length, parseInt(endChapter));
      if (isNaN(startIdx) || isNaN(endIdx) || startIdx >= endIdx) {
        toast.error("Khoảng chương không hợp lệ");
        return;
      }
    }

    setExportDialog(prev => ({ ...prev, isOpen: false }));

    let selectedChapters = chapters.slice(startIdx, endIdx);
    if (isConverted) {
      selectedChapters = selectedChapters.filter(ch => ch.content && ch.content.trim() !== "");
      if (selectedChapters.length === 0) {
        toast.error("Không có chương nào đã biên dịch trong khoảng này.");
        return;
      }
    }
    const suffix = isConverted ? "_converted" : "";

    if (format === 'single') {
      const combinedContent = selectedChapters.map(ch => {
        // Avoid double title: ch.content already includes the title (original or translated)
        // We only prepend ch.title if it's a virtual title like "Phần mở đầu" or "Toàn bộ nội dung"
        if (ch.title === "Phần mở đầu" || ch.title === "Toàn bộ nội dung") {
          return `${ch.title}\n\n${ch.content}`;
        }
        return ch.content;
      }).join('\n\n');
      const rangeSuffix = scope === 'range' ? `_ch${startIdx + 1}_to_${endIdx}` : '';
      const fileName = `${story.name}${suffix}${rangeSuffix}`;
      
      if (type === 'txt') {
        const blob = new Blob([combinedContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (type === 'docx') {
        const blob = await generateDocxBlob(story.name, combinedContent);
        saveAs(blob, `${fileName}.docx`);
      } else {
        await downloadChapterAsPdf(fileName, combinedContent);
      }
      return;
    }

    if (type === 'txt') {
      const zip = new JSZip();
      selectedChapters.forEach((ch, index) => {
        const actualIdx = (ch as any).originalIdx !== undefined ? (ch as any).originalIdx : (startIdx + index);
        const fileName = `${(actualIdx + 1).toString().padStart(3, '0')}_${ch.title.replace(/[\\/:*?"<>|]/g, '_')}${suffix}.txt`;
        zip.file(fileName, ch.content);
      });
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${story.name}${suffix}_chapters_${startIdx + 1}_to_${endIdx}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (type === 'docx') {
      const zip = new JSZip();
      setIsScanning(story.id || 'temp');
      setPdfDownloadProgress({ current: 0, total: selectedChapters.length });
      
      for (let i = 0; i < selectedChapters.length; i++) {
        const ch = selectedChapters[i];
        const actualIdx = (ch as any).originalIdx !== undefined ? (ch as any).originalIdx : (startIdx + i);
        const fileName = `${(actualIdx + 1).toString().padStart(3, '0')}_${ch.title.replace(/[\\/:*?"<>|]/g, '_')}${suffix}.docx`;
        const docxBlob = await generateDocxBlob(ch.title, ch.content);
        zip.file(fileName, docxBlob);
        setPdfDownloadProgress({ current: i + 1, total: selectedChapters.length });
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${story.name}${suffix}_chapters_${startIdx + 1}_to_${endIdx}.zip`);
      setIsScanning(null);
    } else {
      await downloadAsZipPdf(story, selectedChapters, isConverted || false, startIdx);
    }
  };

  const downloadAsZipPdf = async (story: SavedStory, chaptersToExport: {title: string, content: string, originalIdx?: number}[], isConverted: boolean = false, startIdxOffset: number = 0) => {
    const zip = new JSZip();
    const suffix = isConverted ? "_converted" : "";
    
    setIsScanning(story.id || 'temp');
    setPdfDownloadProgress({ current: 0, total: chaptersToExport.length });
    
    try {
      for (let i = 0; i < chaptersToExport.length; i++) {
        const ch = chaptersToExport[i];
        const actualIdx = ch.originalIdx !== undefined ? ch.originalIdx : (startIdxOffset + i);
        const fileName = `${(actualIdx + 1).toString().padStart(3, '0')}_${ch.title.replace(/[\\/:*?"<>|]/g, '_')}${suffix}.pdf`;
        const pdfBlob = await generatePdfBlob(ch.title, ch.content);
        zip.file(fileName, pdfBlob);
        setPdfDownloadProgress({ current: i + 1, total: chaptersToExport.length });
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      const partSuffix = chaptersToExport.length < splitIntoChapters(story.content).length ? `_part` : '';
      a.download = `${story.name}${suffix}_chapters_pdf${partSuffix}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('ZIP PDF generation failed', err);
      setError('Không thể tạo file ZIP PDF. Vui lòng thử lại.');
    } finally {
      setIsScanning(null);
      setPdfDownloadProgress(null);
    }
  };

  const downloadChapter = (title: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSplitClick = (storyId: string) => {
    if (expandedStoryId === storyId) {
      setExpandedStoryId(null);
      return;
    }

    setIsScanning(storyId);
    // Simulate AI scanning for 1.5 seconds
    setTimeout(() => {
      setIsScanning(null);
      setExpandedStoryId(storyId);
    }, 1200);
  };

  // Save library to localStorage safely with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem('gpg_library', JSON.stringify(library));
      } catch (e) {
        console.warn('Failed to save to localStorage', e);
      }
    }, 1000); // Debounce 1s
    return () => clearTimeout(timer);
  }, [library]);

  // Save library to IndexedDB with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      saveToIndexedDB(library).catch(e => console.warn('Failed to save to IndexedDB', e));
    }, 2000); // 2 second debounce for IndexedDB
    return () => clearTimeout(timer);
  }, [library]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
      setDecryptedContent(null);
    }
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      setError(null);
      setDecryptedContent(null);
    }
  }, []);

  const decryptFile = async () => {
    if (!file) return;

    const isTxt = file.name.toLowerCase().endsWith('.txt');
    if (!isTxt && !password) {
      setError('Vui lòng nhập mật khẩu cho file .gpg');
      return;
    }

    setIsDecrypting(true);
    setError(null);

    try {
      if (isTxt) {
        const reader = new FileReader();
        const text = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        setDecryptedContent(text);
      } else {
        const reader = new FileReader();
        const fileData = await new Promise<Uint8Array>((resolve, reject) => {
          reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
          reader.onerror = reject;
          reader.readAsArrayBuffer(file);
        });

        const message = await openpgp.readMessage({
          binaryMessage: fileData
        });

        const { data: decrypted } = await openpgp.decrypt({
          message,
          passwords: [password],
          format: 'utf8'
        });

        setDecryptedContent(decrypted as string);
      }
    } catch (err: any) {
      console.error('Decryption/Read error:', err);
      setError(err.message || 'Xử lý file thất bại. Vui lòng kiểm tra lại.');
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleReplace = () => {
    if (!decryptedContent || !findText) return;
    const newContent = decryptedContent.split(findText).join(replaceText);
    setDecryptedContent(newContent);
    setFindText('');
    setReplaceText('');
  };

  const cleanupTrash = () => {
    if (!decryptedContent) return;
    
    let content = decryptedContent;

    // 1. Lọc tên dịch giả (findAndRemoveCredits)
    const patterns = [
      /Nguồn[:\s]+[^\n]+/gi,
      /Dịch[:\s]+[^\n]+/gi,
      /Editor[:\s]+[^\n]+/gi,
      /Nhóm dịch[:\s]+[^\n]+/gi,
      /Converter[:\s]+[^\n]+/gi,
      /Sưu tầm[:\s]+[^\n]+/gi,
      /Thực hiện[:\s]+[^\n]+/gi,
      /Truyện được đăng tại[^\n]+/gi,
      /Chúc bạn đọc truyện vui vẻ[^\n]*/gi,
      /Chính thức đổi mới rồi sách mới như cây giống đồng dạng tươi mới, nhu cầu cấp bách che chở a, cầu/gi,
      /phiếu đề cử, cầu cất chứa đề cử, đề cử, đề cử, cất chứa, cất chứa, cất chứa, chuyện trọng yếu, ba lượt ba lượt/gi,
      /Cách Chương\./gi,
      /Cầu cất chứa[!\s]*/gi,
      /Cầu đề cử[!\s]*/gi,
      /Cầu phiếu đề cử[!\s]*/gi,
      /Cất chứa[!\s]*/gi,
      /Đề cử[!\s]*/gi,
      /Tiểu thuyết/gi,
      /Nhất Niệm vĩnh hằng Tác Giả/gi,
      /Bên tai số lượng từ/gi,
      /\d+ số lượng từ/gi,
      /\d+ thời gian đổi mới/gi,
      /\d{4} đến \d{2} \d{2} \d{2}, \d{2}/gi
    ];
    patterns.forEach(pattern => {
      content = content.replace(pattern, '');
    });
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    // 2. Xoá trùng lặp (removeDuplicates)
    const lines = content.split('\n');
    const newLines: string[] = [];
    let lastLine = '';
    for (let i = 0; i < lines.length; i++) {
      const currentLine = lines[i].trim();
      if (currentLine !== '' && currentLine === lastLine) continue;
      if (currentLine.toLowerCase().startsWith('chương')) {
        const normalizedCurrent = currentLine.toLowerCase().replace(/[:.,]/g, '').replace(/\s+/g, ' ');
        const normalizedLast = lastLine.toLowerCase().replace(/[:.,]/g, '').replace(/\s+/g, ' ');
        if (normalizedCurrent === normalizedLast) continue;
      }
      newLines.push(lines[i]);
      if (currentLine !== '') lastLine = currentLine;
    }
    content = newLines.join('\n');

    // 3. Xoá tên truyện trong chương (removeStoryNameFromChapters)
    content = content.replace(/^.+?(?:,\s*|-\s*|:\s*)(Chương\s+\d+)/gm, '$1');

    // 4. Quét sửa lỗi (fixSpelling)
    content = content.replace(/\.{2,}/g, '...');
    content = content.replace(/,{2,}/g, ',');
    content = content.replace(/!{2,}/g, '!');
    content = content.replace(/\?{2,}/g, '?');
    content = content.replace(/:{2,}/g, ':');
    content = content.replace(/;{2,}/g, ';');
    content = content.replace(/[^\S\r\n]+([.,!?:;])/g, '$1');
    content = content.replace(/([.,!?:;])([^ \n\d.,!?:;])/g, '$1 $2');
    content = content.replace(/\([^\S\r\n]+/g, '(');
    content = content.replace(/[^\S\r\n]+\)/g, ')');
    content = content.replace(/\[[^\S\r\n]+/g, '[');
    content = content.replace(/[^\S\r\n]+\]/g, ']');
    content = content.replace(/“[^\S\r\n]+/g, '“');
    content = content.replace(/[^\S\r\n]+”/g, '”');
    content = content.replace(/"[^\S\r\n]+/g, '"');
    content = content.replace(/[^\S\r\n]+"/g, '"');
    content = content.replace(/ +/g, ' ');
    // Bổ sung dấu ba chấm … và các biến thể vào regex kết thúc câu
    const sentenceEndings = /(^|[.!?…]\s+)([a-zàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ])/g;
    content = content.replace(sentenceEndings, (match, p1, p2) => p1 + p2.toUpperCase());
    
    // Đảm bảo chữ cái đầu tiên của toàn bộ văn bản luôn được viết hoa
    if (content.length > 0) {
      content = content.charAt(0).toUpperCase() + content.slice(1);
    }

    content = content.split('\n').map(line => {
      let trimmedLine = line.trim();
      if (trimmedLine.length > 0) {
        // Viết hoa chữ cái đầu dòng nếu chưa được viết hoa
        trimmedLine = trimmedLine.charAt(0).toUpperCase() + trimmedLine.slice(1);
      }
      if (trimmedLine.length > 10 && /[a-zA-Z0-9àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]$/.test(trimmedLine)) {
        return trimmedLine + '.';
      }
      return trimmedLine;
    }).join('\n');

    setDecryptedContent(content);
    toast.success("Đã dọn rác thành công (Lọc dịch giả, xoá trùng lặp, xoá tên truyện, sửa lỗi)!");
  };

  const saveLibraryToStorage = async (data: SavedStory[]) => {
    try {
      // Always try IndexedDB first as it has much higher quota
      await saveToIndexedDB(data);
      
      // Also try to save a minimal version to localStorage as backup (metadata only)
      const metadataOnly = data.map(s => ({
        id: s.id,
        name: s.name,
        date: s.date,
        content: "", // Strip content to save space
        processedRanges: s.processedRanges,
        convertedChapters: {} // Strip converted chapters
      }));
      window.localStorage.setItem('gpg_library_metadata', JSON.stringify(metadataOnly));
    } catch (e) {
      console.error('Failed to save library', e);
      setError("Lỗi lưu trữ dữ liệu. Trình duyệt của bạn có thể đã hết dung lượng hoặc không hỗ trợ IndexedDB.");
    }
  };

  const processTextWithAI = async (text: string, onProgress: (progress: number) => void, systemInstructionOverride?: string, onCorrectionsFound?: (corrections: {o: string, n: string}[]) => void, storyErrors?: {o: string, n: string}[]) => {
    if (!text || typeof text !== 'string') return text || '';

    // Local Pre-fix using glossary and storyErrors to save tokens
    let preFixedText = text;
    const allErrors = [...(storyErrors || []), ...glossary.map(g => ({ o: g.original, n: g.translated }))];
    
    if (allErrors.length > 0) {
      // Sort by length descending to avoid partial replacements
      const sortedErrors = [...allErrors].sort((a, b) => b.o.length - a.o.length);
      sortedErrors.forEach(err => {
        if (err.o && err.n && err.o !== err.n) {
          try {
            const escapedOriginal = err.o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            preFixedText = preFixedText.replace(new RegExp(escapedOriginal, 'g'), err.n);
          } catch (e) {
            // Ignore regex errors
          }
        }
      });
    }

    // Strict API Key check
    if (aiProvider === 'gemini' && apiKeys.length === 0) {
      const errorMsg = "Vui lòng cấu hình ít nhất một Gemini API Key trong phần Cài đặt để biên dịch.";
      toast.error(errorMsg);
      throw new Error(errorMsg);
    }
    if (aiProvider === 'openrouter' && openRouterKeys.length === 0) {
      const errorMsg = "Vui lòng cấu hình ít nhất một OpenRouter API Key trong phần Cài đặt để biên dịch.";
      toast.error(errorMsg);
      throw new Error(errorMsg);
    }

    let keyIndex = currentKeyIndexRef.current;
    
    const getAIInstance = (index: number) => {
      if (aiProvider === 'gemini') {
        const key = apiKeys[index];
        if (!key) throw new Error("Không tìm thấy API Key.");
        return new GoogleGenAI({ apiKey: key });
      } else {
        return null; // We'll use fetch for OpenRouter
      }
    };

    let currentAI = getAIInstance(keyIndex);
    const CHUNK_LIMIT = aiProvider === 'gemini' ? 60000 : 8000; // Increased significantly for Gemini to save tokens on repeated instructions
    const chunks: string[] = [];
    
    for (let i = 0; i < preFixedText.length; i += CHUNK_LIMIT) {
      chunks.push(preFixedText.substring(i, i + CHUNK_LIMIT));
    }
    
    const totalChunks = chunks.length;
    let completedChunks = 0;
    const results: string[] = new Array(totalChunks);

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const processChunk = async (chunk: string, index: number, retryCount = 0): Promise<void> => {
      // Check if aborted
      if (!isAutoConvertingRef.current && isAutoConverting) {
        throw new Error("Aborted");
      }

      try {
        let systemInstruction = systemInstructionOverride || "";
        
        if (!systemInstructionOverride) {
          const genreStr = selectedGenres.length > 0 ? selectedGenres.join(", ") : "Tu Tiên/Huyền Huyễn";
          const styleStr = selectedStyles.length > 0 ? selectedStyles.join(", ") : "Biên dịch tự nhiên";
          
          if (translationMode === 'fast') {
            systemInstruction = `Bạn là biên dịch viên truyện ${genreStr}.
Nhiệm vụ: Sửa lỗi Hán Việt, làm văn mượt mà, dễ đọc.
Quy tắc: 
- Giữ 100% ý nghĩa, không thêm/tóm tắt, giữ cấu trúc đoạn.
- GIỮ NGUYÊN biệt danh, danh tự, xưng hô đặc thù của nhân vật (ví dụ: mụ, lão, tiểu tử...).
- CHỈ trả về nội dung.`;
          } else if (translationMode === 'proofread') {
            systemInstruction = `Bạn là biên dịch viên cao cấp. 
Nhiệm vụ: Sửa lỗi (Converter, chính tả, ngữ pháp) TRỰC TIẾP vào văn bản.
Nguyên tắc:
- TRẢ VỀ DUY NHẤT văn bản đã sửa.
- KHÔNG giải thích, KHÔNG chào hỏi.
- GIỮ NGUYÊN cấu trúc đoạn/dòng.
- Ưu tiên mượt mà, đúng ngữ cảnh Việt.`;
          } else {
            systemInstruction = `Bạn là biên dịch viên truyện ${genreStr}, phong cách ${styleStr}.
Nhiệm vụ: Dịch văn bản thô sang tiếng Việt mượt, tự nhiên.
Quy tắc:
- TRẢ VỀ DUY NHẤT văn bản đã dịch.
- Xưng hô: Ngôi 3 dùng "hắn". Giữ đúng xưng hô nhân vật.
- Không tóm tắt, không thêm thắt.
- Bỏ chú thích tác giả.`;
          }
        }

        // Inject consistency prompt if available
        let finalSystemInstruction = systemInstruction;
        if (!systemInstructionOverride && (storyContext || glossary.length > 0)) {
          let consistencyPrompt = "\n\n--- NHẤT QUÁN ---\n";
          if (storyContext) {
            consistencyPrompt += `BỐI CẢNH: ${storyContext}\n`;
          }
          if (glossary.length > 0) {
            consistencyPrompt += `TỪ ĐIỂN: ${glossary.map(g => `${g.original}=>${g.translated}`).join('|')}\n`;
          }
          finalSystemInstruction += consistencyPrompt;
        }

        if (aiProvider === 'gemini') {
          const modelName = geminiModel; 
          const response = await (currentAI as GoogleGenAI).models.generateContent({
            model: modelName,
            config: {
              systemInstruction: finalSystemInstruction
            },
            contents: chunk,
          });
          
          const responseText = response.text || "";
          results[index] = responseText;
          
          // Estimate tokens for Gemini (approx 1 token per 4 chars if not provided)
          const estimatedTokens = response.usageMetadata?.totalTokenCount || Math.ceil((chunk.length + (response.text?.length || 0)) / 4);
          updateDailyTokens(estimatedTokens);
        } else {
          const key = openRouterKeys.length > 0 ? openRouterKeys[keyIndex] : '';
          
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${key}`,
              "HTTP-Referer": window.location.origin,
              "X-OpenRouter-Title": "GPG Decryptor",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              "model": openRouterModel,
              "messages": [
                { "role": "system", "content": finalSystemInstruction },
                { "role": "user", "content": chunk }
              ],
              "max_tokens": 4000 
            })
          });
            
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData?.error?.message || `OpenRouter error: ${response.status}`);
          }
          
          const data = await response.json();
          const responseText = data.choices[0].message.content || "";
          results[index] = responseText;

          if (data.usage?.total_tokens) {
            updateDailyTokens(data.usage.total_tokens);
          }
            
            // Log reasoning tokens if available (Gemma 4 support)
            if (data.usage?.reasoning_tokens) {
              console.log(`[AI Reasoning] Chunk ${index}: ${data.usage.reasoning_tokens} tokens`);
            }
          }
      } catch (err: any) {
        const errorMessage = err?.message?.toLowerCase() || '';
        const isRateLimit = errorMessage.includes('429') || err?.status === 'RESOURCE_EXHAUSTED' || errorMessage.includes('quota');
        
        if (isRateLimit) {
          const currentKeys = aiProvider === 'gemini' ? apiKeys : openRouterKeys;
          // Find next enabled key
          let nextKeyIndex = keyIndex + 1;
          while (nextKeyIndex < currentKeys.length && disabledKeys.includes(currentKeys[nextKeyIndex])) {
            nextKeyIndex++;
          }

          if (nextKeyIndex < currentKeys.length) {
            keyIndex = nextKeyIndex;
            setCurrentKeyIndex(keyIndex);
            currentAI = getAIInstance(keyIndex);
            const msg = `Giới hạn tốc độ. Đang chuyển sang API Key #${keyIndex + 1}/${currentKeys.length}...`;
            console.warn(msg);
            toast.info(msg);
            
            // Small delay before retry with new key
            await delay(1000);
            return processChunk(chunk, index, retryCount + 1);
          }

          // If we've tried all keys, stop
          const fatalError = "Tất cả API Key đã đạt giới hạn tốc độ hoặc bị vô hiệu hóa. Dừng dịch.";
          toast.error(fatalError);
          setError(fatalError);
          throw new Error(fatalError);
        }

        const isCreditError = errorMessage.includes('credit') || 
                            errorMessage.includes('balance') ||
                            errorMessage.includes('insufficient') ||
                            errorMessage.includes('payment required') ||
                            errorMessage.includes('402') ||
                            errorMessage.includes('403') ||
                            errorMessage.includes('400') ||
                            errorMessage.includes('api key not valid') ||
                            errorMessage.includes('api_key_invalid');
        
        if (isCreditError) {
          const currentKeys = aiProvider === 'gemini' ? apiKeys : openRouterKeys;
          // Find next enabled key
          let nextKeyIndex = keyIndex + 1;
          while (nextKeyIndex < currentKeys.length && disabledKeys.includes(currentKeys[nextKeyIndex])) {
            nextKeyIndex++;
          }

          if (nextKeyIndex < currentKeys.length) {
            keyIndex = nextKeyIndex;
            setCurrentKeyIndex(keyIndex);
            currentAI = getAIInstance(keyIndex);
            const msg = `Lỗi số dư/hết hạn. Đang chuyển sang API Key #${keyIndex + 1}/${currentKeys.length}...`;
            console.warn(msg);
            toast.info(msg);
            return processChunk(chunk, index, retryCount + 1);
          }
          
          const fatalError = "Tất cả API Key đã hết hạn, hết số dư hoặc bị vô hiệu hóa. Dừng dịch.";
          toast.error(fatalError, { duration: 5000 });
          setError(fatalError);
          throw new Error(fatalError); // Throw to stop the batch processing
        }

        const isTransientError = errorMessage.includes('rpc failed') || 
                                errorMessage.includes('xhr error') ||
                                errorMessage.includes('500') ||
                                errorMessage.includes('fetch failed');
        
        if (isTransientError && retryCount < 5) {
          const waitTime = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          console.warn(`Transient error for chunk ${index} (RPC/XHR/500). Retrying in ${Math.round(waitTime/1000)}s... (Attempt ${retryCount + 1})`);
          await delay(waitTime);
          return processChunk(chunk, index, retryCount + 1);
        }

        console.error(`Chunk ${index} processing failed after ${retryCount} retries`, err instanceof Error ? err.message : String(err));
        // For other non-fatal errors, retry up to 2 times
        if (retryCount < 2) {
          await delay(2000);
          return processChunk(chunk, index, retryCount + 1);
        }
        results[index] = chunk;
      } finally {
        if (retryCount === 0 || results[index]) { // Only count as completed if it's the first attempt or it finally succeeded/failed
          completedChunks++;
          onProgress(Math.round((completedChunks / totalChunks) * 100));
        }
      }
    };

    const CONCURRENCY = 3; // Slightly increased for speed, balanced with retry logic
    const BATCH_SIZE = 10; // Process 10 chapters at a time for better tracking
    
    try {
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY).map((chunk, batchIndex) => 
          processChunk(chunk, i + batchIndex)
        );
        await Promise.all(batch);
        
        // Update progress more frequently if needed
        if (i + CONCURRENCY < chunks.length) {
          await delay(1000); // Small pause between batches
        }
      }
    } catch (err) {
      console.error("AI Processing aborted due to fatal error:", err);
      throw err; // Rethrow to stop callers
    }
    
    return results.join('');
  };

  const processPartWithAI = async (story: SavedStory, partIndex: number) => {
    const chapters = splitIntoChapters(story.content);
    const PART_SIZE = 100;
    const startIdx = partIndex * PART_SIZE;
    const endIdx = Math.min(startIdx + PART_SIZE, chapters.length);
    
    const chaptersToProcess = chapters.slice(startIdx, endIdx);
    const totalInPart = chaptersToProcess.length;
    
    setIsProcessingPart(true);
    setPartProgress(0);
    setError(null);

    try {
      const processedChapters: string[] = [];
      let newCorrections: {o: string, n: string}[] = [];
      
      // Process 10 chapters at a time within the part
      const SUB_BATCH_SIZE = 10;
      for (let i = 0; i < totalInPart; i += SUB_BATCH_SIZE) {
        const subBatch = chaptersToProcess.slice(i, i + SUB_BATCH_SIZE);
        
        const batchResults = await Promise.all(subBatch.map(async (ch, subIdx) => {
          const result = await processTextWithAI(ch.content, () => {}, undefined, (corrections) => {
            newCorrections.push(...corrections);
          }, story.commonErrors);
          // Since ch.content already includes the title, result will also include it.
          // We don't need to add ch.title again.
          return result;
        }));
        
        processedChapters.push(...batchResults);
        setPartProgress(Math.round(((i + subBatch.length) / totalInPart) * 100));
      }

      // Reconstruct the story with processed part
      const allChapters = splitIntoChapters(story.content);
      const updatedContentParts = allChapters.map((ch, idx) => {
        if (idx >= startIdx && idx < endIdx) {
          return processedChapters[idx - startIdx];
        }
        return ch.content;
      });

      const updatedContent = updatedContentParts.join('\n\n').trim();
      
      if (!updatedContent) {
        throw new Error("Nội dung sau khi xử lý bị trống.");
      }

      setLibrary(prev => prev.map(s => {
        if (s.id === story.id) {
          const currentRanges = s.processedRanges || [];
          // Add new range if not already tracked
          const rangeExists = currentRanges.some(r => r.start === startIdx && r.end === endIdx);
          const newRanges = rangeExists ? currentRanges : [...currentRanges, { start: startIdx, end: endIdx }];
          
          let updatedErrors = s.commonErrors || [];
          if (newCorrections.length > 0) {
            const errorMap = new Map();
            updatedErrors.forEach(e => errorMap.set(e.o, e.n));
            newCorrections.forEach(c => errorMap.set(c.o, c.n));
            updatedErrors = Array.from(errorMap.entries()).map(([o, n]) => ({ o, n }));
          }

          return { ...s, content: updatedContent, processedRanges: newRanges, commonErrors: updatedErrors };
        }
        return s;
      }));
      
      // Trigger a refresh of the expanded view
      setExpandedStoryId(null);
      setTimeout(() => setExpandedStoryId(story.id), 10);
      
    } catch (err) {
      console.error("Part processing failed", err instanceof Error ? err.message : String(err));
      setError("Xử lý phần thất bại. Vui lòng thử lại.");
    } finally {
      setIsProcessingPart(false);
    }
  };

  const processSingleChapterWithAI = async (story: SavedStory, chapterIndex: number) => {
    const chapters = splitIntoChapters(story.content);
    if (chapterIndex < 0 || chapterIndex >= chapters.length) return;
    
    const chapter = chapters[chapterIndex];
    setIsProcessingPart(true);
    setPartProgress(0);
    setError(null);

    try {
      let newCorrections: {o: string, n: string}[] = [];
      const result = await processTextWithAI(chapter.content, (p) => setPartProgress(p), undefined, (corrections) => {
        newCorrections.push(...corrections);
      }, story.commonErrors);
      
      if (!result) throw new Error("Kết quả xử lý trống.");

      // Create a new entry for testing
      const testStory: SavedStory = {
        id: `test_${Date.now()}`,
        name: `[TEST] ${story.name} - ${chapter.title}`,
        content: result,
        date: new Date().toLocaleString('vi-VN'),
        processedRanges: [{ start: 0, end: 1 }],
        commonErrors: newCorrections.length > 0 ? newCorrections : undefined
      };

      setLibrary(prev => [testStory, ...prev]);
      setActiveTab('library');
      setExpandedStoryId(testStory.id);
      
      // Also update the original story
      setLibrary(prev => prev.map(s => {
        if (s.id === story.id) {
          const updatedChapters = [...chapters];
          updatedChapters[chapterIndex] = { ...chapter, content: result };
          const updatedContent = updatedChapters.map(c => c.content).join('\n\n');
          
          const currentRanges = s.processedRanges || [];
          const rangeExists = currentRanges.some(r => r.start === chapterIndex && r.end === chapterIndex + 1);
          const newRanges = rangeExists ? currentRanges : [...currentRanges, { start: chapterIndex, end: chapterIndex + 1 }];
          
          let updatedErrors = s.commonErrors || [];
          if (newCorrections.length > 0) {
            const errorMap = new Map();
            updatedErrors.forEach(e => errorMap.set(e.o, e.n));
            newCorrections.forEach(c => errorMap.set(c.o, c.n));
            updatedErrors = Array.from(errorMap.entries()).map(([o, n]) => ({ o, n }));
          }

          return { ...s, content: updatedContent, processedRanges: newRanges, commonErrors: updatedErrors };
        }
        return s;
      }));

    } catch (err: any) {
      console.error("Single chapter processing failed", err);
      setError(`Lỗi xử lý chương: ${err.message || 'Không rõ nguyên nhân'}`);
    } finally {
      setIsProcessingPart(false);
      setPartProgress(0);
    }
  };

  const processSelectedChapter = async (chapterIdx?: number) => {
    const idx = chapterIdx !== undefined ? chapterIdx : selectedConvertChapterIdx;
    if (selectedConvertStoryId === null || idx === null) return;
    
    const story = library.find(s => s.id === selectedConvertStoryId);
    if (!story) return;
    
    const chapters = splitIntoChapters(story.content);
    if (idx < 0 || idx >= chapters.length) return;
    
    const chapter = chapters[idx];
    setIsProcessingPart(true);
    setPartProgress(0);
    setError(null);
    
    try {
      const lines = chapter.content.split('\n');
      const titleLine = lines[0] || "";
      const bodyContent = lines.slice(1).join('\n');

      let newCorrections: {o: string, n: string}[] = [];
      const resultBody = await processTextWithAI(bodyContent, (p) => setPartProgress(p), undefined, (corrections) => {
        newCorrections.push(...corrections);
      }, story.commonErrors);
      if (!resultBody) throw new Error("Kết quả xử lý trống.");
      
      const finalResult = titleLine + "\n\n" + resultBody.trim();
      
      let isSuccess = false;
      setLibrary(prevLibrary => {
        const updatedLibrary = prevLibrary.map(s => {
          if (s.id === story.id) {
            const converted = s.convertedChapters || {};
            
            let updatedErrors = s.commonErrors || [];
            if (newCorrections.length > 0) {
              const errorMap = new Map();
              updatedErrors.forEach(e => errorMap.set(e.o, e.n));
              newCorrections.forEach(c => errorMap.set(c.o, c.n));
              updatedErrors = Array.from(errorMap.entries()).map(([o, n]) => ({ o, n }));
            }

            return {
              ...s,
              convertedChapters: {
                ...converted,
                [idx]: finalResult
              },
              commonErrors: updatedErrors
            };
          }
          return s;
        });
        return updatedLibrary;
      });
      
      return true;
    } catch (err: any) {
      console.error("Chapter conversion failed", err);
      setError(`Lỗi biên dịch chương ${idx + 1}: ${err.message || 'Không rõ nguyên nhân'}`);
      return false;
    } finally {
      setIsProcessingPart(false);
      setPartProgress(0);
    }
  };

  const startAutoConversion = async () => {
    if (selectedConvertStoryId === null) return;
    const story = library.find(s => s.id === selectedConvertStoryId);
    if (!story) return;

    const chapters = currentConvertChapters;
    setIsAutoConverting(true);
    
    const chapterIndices = [];
    for (let i = 0; i < chapters.length; i++) {
      if ((story.convertedChapters && story.convertedChapters[i]) || i < skipChaptersCount) continue;
      chapterIndices.push(i);
    }

    // Process in batches based on concurrency
    for (let i = 0; i < chapterIndices.length; i += concurrency) {
      if (!isAutoConvertingRef.current) break;
      
      const batch = chapterIndices.slice(i, i + concurrency);
      await Promise.all(batch.map(async (idx) => {
        if (!isAutoConvertingRef.current) return;
        setSelectedConvertChapterIdx(idx);
        await processSelectedChapter(idx);
      }));

      // Small pause between batches
      if (isAutoConvertingRef.current) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    setIsAutoConverting(false);
  };

  const combinedSmartFixAI = async () => {
    if (!decryptedContent) return;
    setIsFixingAI(true);
    setAiProgress(0);
    setError(null);
    try {
      let newCorrections: {o: string, n: string}[] = [];
      const finalResult = await processTextWithAI(decryptedContent, setAiProgress, undefined, (corrections) => {
        newCorrections.push(...corrections);
      });
      setDecryptedContent(finalResult);
      
      // Automatically save to library and switch tab
      saveToLibrary(finalResult, newCorrections.length > 0 ? newCorrections : undefined);
      
    } catch (err) {
      console.error('AI Combined Fix failed', err);
      setError('Xử lý toàn diện bằng AI thất bại. Vui lòng thử lại sau.');
    } finally {
      setIsFixingAI(false);
      setAiProgress(0);
    }
  };

  const testSmartFixAI = async () => {
    if (!decryptedContent || testChapterCount <= 0) return;
    setIsFixingAI(true);
    setAiProgress(0);
    setError(null);
    try {
      const allChapters = splitIntoChapters(decryptedContent);
      
      // Take only the requested number of chapters
      const chaptersToProcess = allChapters.slice(0, testChapterCount);
      const remainingChapters = allChapters.slice(testChapterCount);
      
      const textToProcess = chaptersToProcess.map(c => c.content).join('');
      
      let newCorrections: {o: string, n: string}[] = [];
      const processedPart = await processTextWithAI(textToProcess, setAiProgress, undefined, (corrections) => {
        newCorrections.push(...corrections);
      });
      
      const remainingPart = remainingChapters.map(c => c.content).join('');
      const finalResult = processedPart + remainingPart;
      
      setDecryptedContent(finalResult);
      
      // Automatically save to library and switch tab
      saveToLibrary(finalResult, newCorrections.length > 0 ? newCorrections : undefined);
      
    } catch (err) {
      console.error('AI Test Fix failed', err);
      setError('Xử lý thử nghiệm bằng AI thất bại. Vui lòng thử lại sau.');
    } finally {
      setIsFixingAI(false);
      setAiProgress(0);
    }
  };

  const chapters = useMemo(() => {
    if (!decryptedContent) return [];
    return splitIntoChapters(decryptedContent);
  }, [decryptedContent, customPrefix, isStrictMode]);

  const saveToLibrary = (contentOverride?: any, commonErrors?: {o: string, n: string}[]) => {
    // Check if contentOverride is a string, otherwise ignore it (it might be a React event)
    const contentToSave = typeof contentOverride === 'string' ? contentOverride : decryptedContent;
    
    if (!contentToSave || typeof contentToSave !== 'string' || contentToSave.trim().length === 0) {
      setError("Nội dung trống, không thể lưu.");
      return;
    }
    
    setSaveStoryDialog({
      isOpen: true,
      name: file ? file.name.replace('.gpg', '') : 'Truyện không tên',
      genre: '',
      description: '',
      content: contentToSave,
      isGenerating: false,
      commonErrors: commonErrors
    });

    // Automatically trigger AI generation
    generateStoryMetadata(contentToSave);
  };

  const generateStoryMetadata = async (contentOverride?: string) => {
    const contentToAnalyze = contentOverride || saveStoryDialog.content;
    if (!contentToAnalyze) return;
    
    setSaveStoryDialog(prev => ({ ...prev, isGenerating: true }));
    try {
      // Use first 5000 chars for analysis
      const sampleContent = contentToAnalyze.substring(0, 5000);
      
      const prompt = `Dựa vào nội dung truyện sau đây, hãy thực hiện 2 việc:
1. Xác định thể loại truyện (ví dụ: Tiên Hiệp, Huyền Huyễn, Đô Thị, Ngôn Tình...).
2. Viết một đoạn giới thiệu truyện (summary/blurb) ngắn gọn nhưng hấp dẫn, lôi cuốn, khiến người đọc muốn đọc ngay. Độ dài khoảng 3-5 câu.

Nội dung truyện:
${sampleContent}

Yêu cầu trả về định dạng JSON như sau:
{
  "genre": "Tên thể loại",
  "description": "Đoạn giới thiệu hấp dẫn"
}`;

      let text = "";
      if (aiProvider === 'gemini') {
        const key = apiKeys[currentKeyIndexRef.current] || process.env.GEMINI_API_KEY!;
        const genAI = new GoogleGenAI({ apiKey: key });
        const response = await genAI.models.generateContent({
          model: geminiModel,
          contents: prompt
        });
        text = response.text || "";
      } else {
        const key = openRouterKeys.length > 0 ? openRouterKeys[currentKeyIndexRef.current] : '';
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "HTTP-Referer": window.location.origin,
            "X-OpenRouter-Title": "GPG Decryptor",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            "model": openRouterModel,
            "messages": [
              { "role": "system", "content": "Bạn là trợ lý phân tích văn học. Trả về kết quả dưới dạng JSON." },
              { "role": "user", "content": prompt }
            ]
          })
        });
        const data = await response.json();
        text = data.choices[0].message.content || "";
      }
      
      // Clean up JSON if AI adds markdown blocks
      const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const metadata = JSON.parse(jsonStr);
      
      setSaveStoryDialog(prev => ({
        ...prev,
        genre: metadata.genre || prev.genre,
        description: metadata.description || prev.description,
        isGenerating: false
      }));
      toast.success("Đã tự động tạo thông tin truyện!");
    } catch (err) {
      console.error('Metadata generation failed', err);
      toast.error("Không thể tự động tạo thông tin. Vui lòng thử lại hoặc tự nhập.");
      setSaveStoryDialog(prev => ({ ...prev, isGenerating: false }));
    }
  };

  const confirmSaveToLibrary = () => {
    const newStory: SavedStory = {
      id: Date.now().toString(),
      name: saveStoryDialog.name || 'Truyện không tên',
      genre: saveStoryDialog.genre,
      description: saveStoryDialog.description,
      content: saveStoryDialog.content,
      date: new Date().toLocaleString('vi-VN'),
      commonErrors: saveStoryDialog.commonErrors
    };
    setLibrary(prev => {
      const updated = [newStory, ...prev];
      return updated;
    });
    setSaveStoryDialog({ ...saveStoryDialog, isOpen: false });
    setActiveTab('library');
    setExpandedStoryId(newStory.id);
    // Reset decryption state after saving
    setFile(null);
    setDecryptedContent(null);
    setPassword('');
    toast.success("Đã lưu vào kho lưu trữ!");
  };

  const deleteFromLibrary = (id: string) => {
    setLibrary(prev => {
      const updated = prev.filter(s => s.id !== id);
      return updated;
    });
  };

  const filterExtraDots = (id: string) => {
    setLibrary(prev => {
      const updated = prev.map(story => {
        if (story.id === id) {
          // Remove lines that only contain a dot (with optional whitespace)
          let newContent = story.content.replace(/^\s*\.\s*$/gm, '');
          // Clean up multiple empty lines left behind
          newContent = newContent.replace(/\n{3,}/g, '\n\n').trim();
          return { ...story, content: newContent };
        }
        return story;
      });
      return updated;
    });
    toast.success("Đã lọc các dấu chấm (.) thừa!");
  };

  const renumberChapters = (storyId: string, startNum: number, targetPrefix: string) => {
    setLibrary(prev => {
      const updated = prev.map(story => {
        if (story.id === storyId) {
          // 1. Split into chapters using the robust logic to identify actual chapter blocks
          const chapters = splitIntoChapters(story.content);
          
          if (chapters.length <= 1 && chapters[0]?.title === "Toàn bộ nội dung") {
            toast.error("Không tìm thấy chương nào để đánh số lại!");
            return story;
          }

          // 2. Renumber each chapter's title line
          const renumberedContent = chapters.map((ch, idx) => {
            const newNum = startNum + idx;
            const lines = ch.content.split('\n');
            if (lines.length > 0) {
              // The first line is the title line
              const pattern = `^([ \\t]*(${targetPrefix})\\s*)(\\d+|[IVXLCDM]+)`;
              const regex = new RegExp(pattern, "i");
              
              // Only replace if it matches the prefix
              if (lines[0].match(regex)) {
                lines[0] = lines[0].replace(regex, (match, fullPrefix) => {
                  return `${fullPrefix}${newNum}`;
                });
              }
            }
            return lines.join('\n');
          }).join('\n\n');
          
          return { ...story, content: renumberedContent };
        }
        return story;
      });
      return updated;
    });
    toast.success(`Đã đánh số lại ${targetPrefix} theo thứ tự (1, 2, 3...) thành công!`);
    setRenumberDialog({ ...renumberDialog, isOpen: false });
  };

  const renameChapter = (storyId: string, chapterIdx: number, newTitle: string) => {
    setLibrary(prev => {
      const updated = prev.map(story => {
        if (story.id === storyId) {
          return {
            ...story,
            customChapterTitles: {
              ...(story.customChapterTitles || {}),
              [chapterIdx]: newTitle
            }
          };
        }
        return story;
      });
      return updated;
    });
    toast.success("Đã đổi tên chương thành công!");
    setRenameChapterDialog({ ...renameChapterDialog, isOpen: false });
  };

  const optimizeLineBreaks = (storyId: string) => {
    setLibrary(prev => {
      const updated = prev.map(story => {
        if (story.id === storyId) {
          const chapters = splitIntoChapters(story.content);
          const optimizedContent = chapters.map(ch => {
            const lines = ch.content.split('\n');
            if (lines.length === 0) return "";
            
            const titleLine = lines[0];
            let body = lines.slice(1).join('\n');
            
            // 1. Standardize dialogue markers (ensure they are at the start of a line)
            body = body.replace(/([.!?])\s+([–\-"“])/g, '$1\n\n$2');
            
            // 2. Ensure existing markers start on new lines if they are mid-sentence
            body = body.replace(/([^\n])\s+([–\-"“])/g, '$1\n\n$2');
            
            // 3. Fix cases where dialogue ends and narration starts on the same line
            body = body.replace(/([”"!?])\s+([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠ])/g, '$1\n\n$2');

            // 4. Handle double spaces after sentence ends
            body = body.replace(/([.!?])\s{2,}([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠ])/g, '$1\n\n$2');

            // 5. Clean up multiple newlines
            body = body.replace(/\n{3,}/g, '\n\n');
            
            return titleLine + '\n' + body;
          }).join('\n\n');
          
          return { ...story, content: optimizedContent.trim() };
        }
        return story;
      });
      return updated;
    });
    toast.success("Đã tối ưu xuống dòng và định dạng đoạn văn!");
  };

  const runUniqueWordAnalysis = () => {
    if (!batchInput) {
      toast.error("Vui lòng nhập văn bản để phân tích.");
      return;
    }
    
    setIsAnalyzingWords(true);
    
    // Simulate some dealy for UX
    setTimeout(() => {
      const text = batchInput;
      // Tokenize into words
      const words = text.split(/[\s.,!?;:"'()]+/).filter(w => w.length > 1 && isNaN(Number(w)));
      
      const counts: Record<string, number> = {};
      words.forEach(w => {
        const lower = w.toLowerCase();
        counts[lower] = (counts[lower] || 0) + 1;
      });
      
      const analysis = Object.entries(counts).map(([word, count]) => ({
        word,
        count,
        isSuspicious: !isPossibleVietnameseWord(word)
      }));
      
      // Sort by suspicious first, then by count descending
      analysis.sort((a, b) => {
        if (a.isSuspicious && !b.isSuspicious) return -1;
        if (!a.isSuspicious && b.isSuspicious) return 1;
        return b.count - a.count;
      });
      
      setUniqueWordAnalysis(analysis);
      setIsAnalyzingWords(false);
      toast.success("Đã phân tích xong từ vựng!");
    }, 500);
  };

  const handleStartSegmentation = () => {
    if (!batchInput) {
      toast.error("Vui lòng nhập văn bản.");
      return;
    }

    // Split by punctuation: , . ! ? ; : and newline. We use a regex with lookbehind to keep the delimiter.
    // We split after every punctuation mark.
    const rawSegments = batchInput.split(/(?<=[,.;:!?\n])\s*/g).filter(s => s.trim().length > 0);
    
    const newSegments: SegmentItem[] = rawSegments.map((text, index) => {
      const trimmed = text.trim();
      // Auto-scan words in segment
      const words = trimmed.split(/[\s.,!?;:"'()]+/).filter(w => w.length > 1);
      const suspicious = words.filter(w => !isPossibleVietnameseWord(w));
      
      // Check for dictionary matches
      const hasDictMatch = Object.keys(COMMON_PHRASE_ERRORS).some(wrong => 
        trimmed.toLowerCase().includes(wrong.toLowerCase())
      );

      return {
        id: `seg-${Date.now()}-${index}`,
        text: trimmed,
        status: (suspicious.length > 0 || hasDictMatch) ? 'err' : 'unknown',
        suspiciousWords: suspicious
      };
    });

    setSegments(newSegments);
    setActiveBatchStep('segments');
    
    const errCount = newSegments.filter(s => s.status === 'err').length;
    toast.success(`Đã phân tách thành ${newSegments.length} đoạn. Phát hiện ${errCount} đoạn nghi yếu.`);
  };

  const updateSegmentStatus = (id: string, status: 'ok' | 'err' | 'unknown') => {
    setSegments(prev => prev.map(s => s.id === id ? { ...s, status } : s));
  };

  const handleRunBatchFix = async () => {
    if (!batchInput) {
      toast.error("Vui lòng nhập văn bản cần xử lý.");
      return;
    }

    if (useAIForAmbiguous && aiProvider === 'gemini' && apiKeys.length === 0) {
      toast.error("Vui lòng cấu hình ít nhất một Gemini API Key trong phần Cài đặt để sử dụng AI.");
      return;
    }
    
    setIsProcessingBatch(true);
    setActiveBatchStep('processing');
    setBatchStats({ fixed: 0, ambiguous: 0, ai: 0 });
    
    try {
      let text = batchInput;

      // 0. Manual Phrase Dictionary (Multi-word fixes first)
      let phraseFixCount = 0;
      Object.entries(COMMON_PHRASE_ERRORS).forEach(([wrong, right]) => {
        const regexArr = [
          new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
          // Variant: sometimes words are stuck together in converter logs
          new RegExp(wrong.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        ];
        
        regexArr.forEach(regex => {
          const matches = text.match(regex);
          if (matches) {
            phraseFixCount += matches.length;
            text = text.replace(regex, (match) => {
              // Try to maintain capitalization
              return match[0] === match[0].toUpperCase() 
                ? right[0].toUpperCase() + right.slice(1) 
                : right;
            });
          }
        });
      });

      // 1. Normalization
      if (normalizePunc) {
        text = text.replace(/\.{2,}/g, '...');
        text = text.replace(/,{2,}/g, ',');
        text = text.replace(/ +/g, ' ');
      }

      // --- NEW: Deep Clean Mode (AI Proofreads chunks) ---
      if (useDeepClean && aiProvider === 'gemini') {
        const chunks: string[] = [];
        const chunkSize = 5000;
        for (let i = 0; i < text.length; i += chunkSize) {
          chunks.push(text.slice(i, i + chunkSize));
        }

        let cleanedText = "";
        let totalAiCount = 0;

        for (let i = 0; i < chunks.length; i++) {
          const prompt = `Bạn là chuyên gia hiệu đính văn bản truyện Tiếng Việt (converter).
NHIỆM VỤ:
1. Sửa toàn bộ lỗi chính tả, lỗi dấu, lỗi converter (Ví dụ: "phụ than" -> "phụ thân", "tinh sảo" -> "tinh xảo", "yệu" -> "yêu/yếu", "tư vị" -> "hương vị" nếu cần).
2. ĐẶC BIỆT chú ý các lỗi ngữ cảnh: "phụ than", "tinh sảo", "yệu thương", "mẫu than".
3. Giữ nguyên phong cách, cách xưng hô và nội dung truyện. 
4. Chỉ trả về VĂN BẢN ĐÃ SỬA, tuyệt đối không trả về lời giải thích.

VĂN BẢN CẦN SỬA:
${chunks[i]}`;

          try {
            const result = await processTextWithAI(prompt, () => {}, "Chuyên gia Tiếng Việt.");
            cleanedText += result;
            totalAiCount++;
          } catch (err) {
            console.error(`Chunk ${i} failed, skipping:`, err);
            cleanedText += chunks[i];
          }
        }

        setBatchOutput(cleanedText);
        setBatchStats({ fixed: phraseFixCount, ambiguous: 0, ai: totalAiCount });
        setActiveBatchStep('result');
        toast.success("Hoàn thành xử lý chuyên sâu!");
        setIsProcessingBatch(false);
        return;
      }

      let fixedCount = phraseFixCount;
      let ambigCount = 0;
      let aiCount = 0;

      // Tokenize the text (keep spaces and punctuation)
      const tokens = text.split(/(\s+|[.,!?;:"'()])/);
      
      // Auto-scan for strange syllables
      const sessionBatchRules = [...batchRules];
      if (autoScanEnabled) {
        const wordsInText = tokens.filter(t => t.length > 1 && !/\s+|[.,!?;:"'()]/.test(t));
        const uniqueStrangeWords = (Array.from(new Set(wordsInText.map(w => w.toLowerCase()))) as string[])
          .filter(w => !isPossibleVietnameseWord(w));
        
        uniqueStrangeWords.forEach(w => {
          if (!sessionBatchRules.some(r => r.original === w)) {
            sessionBatchRules.push({
              id: 'auto-' + w,
              original: w,
              replacement: '',
              type: 'ambiguous'
            });
          }
        });
      }

      const fixedRules = sessionBatchRules.filter(r => r.type === 'fixed');
      const ambigRules = sessionBatchRules.filter(r => r.type === 'ambiguous');
      let markers: AmbiguousMarker[] = [];

      // Process tokens one by one
      const processedTokens = tokens.map((token, index) => {
        if (!token || /\s+|[.,!?;:"'()]/.test(token)) return token;

        const lowerToken = token.toLowerCase();
        
        // Skip correct Vietnamese words to minimize AI markers
        if (isPossibleVietnameseWord(token)) return token;

        // Fixed rules
        const fixedMatch = fixedRules.find(r => r.original.toLowerCase() === lowerToken);
        if (fixedMatch) {
          fixedCount++;
          const replacement = token[0] === token[0].toUpperCase() 
            ? fixedMatch.replacement[0].toUpperCase() + fixedMatch.replacement.slice(1) 
            : fixedMatch.replacement;
          return replacement;
        }

        // Ambiguous Rules (only if suspicious)
        const ambigMatch = ambigRules.find(r => r.original.toLowerCase() === lowerToken);
        if (ambigMatch) {
          const before = tokens.slice(Math.max(0, index - 3), index).join('');
          const after = tokens.slice(index + 1, index + 4).join('');
          const fullSentence = before + token + after;
          
          let resolved = "";
          let method: 'heuristic' | 'ai' | undefined = undefined;

          // Smarter Heuristics
          if (lowerToken === 'yệu') {
            const contextLower = (before + after).toLowerCase();
            if (["kém", "ớt", "đuối", "nhược", "hèn", "phế", "mềm", "bệnh", "liễu", "yếu"].some(w => contextLower.includes(w))) {
              resolved = token === 'yệu' ? 'yếu' : 'Yếu';
              method = 'heuristic';
            } else if (["nàng", "người", "quân", "thuật", "thương", "đang", "thích", "chiều", "mến", "yêu", "vợ", "chồng", "sinh", "hoạt"].some(w => contextLower.includes(w))) {
              resolved = token === 'yệu' ? 'yêu' : 'Yêu';
              method = 'heuristic';
            }
          }

          const markerId = Math.random().toString(36).substr(2, 9);
          markers.push({
            id: markerId,
            original: token,
            contextBefore: before,
            contextAfter: after,
            fullSentence,
            resolvedReplacement: resolved,
            method,
            startIndex: index
          });
          
          return resolved ? resolved : `__MARKER_${markerId}__`;
        }

        return token;
      });

      // Filter markers to only send AI what really matters
      // (Words with no resolution and no markers assigned as resolved)
      const markersToAi = markers.filter(m => !m.resolvedReplacement);
      aiCount = markersToAi.length;
      ambigCount = markers.length;

      // 4. AI Batch Resolve - ONLY if needed and enabled
      if (useAIForAmbiguous && aiCount > 0) {
        // Limit AI resolving to max 50 markers per run to prevent token blast
        const limitedMarkers = markersToAi.slice(0, 100);
        
        const prompt = `Mục tiêu: Hiệu đính các từ lỗi [AMBIG:...] trong truyện Tiếng Việt.
Trả về JSON list các từ đúng theo thứ tự. Nếu từ đã đúng thì giữ nguyên.

Ví dụ:
[
  "yêu",
  "yếu"
]

Cần xử lý:
${limitedMarkers.map((m, i) => `${i+1}. ${m.fullSentence.replace(m.original, `[AMBIG:${m.original}]`)}`).join('\n')}`;

        try {
          const aiText = await processTextWithAI(prompt, () => {}, "Bạn là chuyên gia ngôn ngữ Tiếng Việt.");
          let suggestions: string[] = [];
          
          const jsonMatch = aiText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            suggestions = JSON.parse(jsonMatch[0]);
          } else {
            suggestions = aiText.split('\n').map(s => s.replace(/^\d+\.\s*/, '').trim()).filter(s => s.length > 0);
          }
          
          let aiIdx = 0;
          markers = markers.map(m => {
            const isTarget = !m.resolvedReplacement && limitedMarkers.some(lm => lm.id === m.id);
            if (isTarget && aiIdx < suggestions.length) {
              const res = suggestions[aiIdx++];
              if (res && res.toLowerCase() !== m.original.toLowerCase()) {
                return { ...m, resolvedReplacement: res, method: 'ai' };
              }
            }
            return m;
          });
        } catch (err) {
          console.error("AI Resolve failed:", err);
        }
      }

      // Reassemble text
      const finalOutput = processedTokens.map(token => {
        if (token && token.startsWith('__MARKER_') && token.endsWith('__')) {
          const id = token.slice(9, -2);
          const m = markers.find(m => m.id === id);
          return (m && m.resolvedReplacement) ? m.resolvedReplacement : (m ? m.original : token);
        }
        return token;
      }).join('');

      setBatchOutput(finalOutput);
      setAmbiguousMarkers(markers);
      setBatchStats({ fixed: fixedCount, ambiguous: ambigCount, ai: markers.filter(m => m.method === 'ai').length });
      setActiveBatchStep('result');
      toast.success("Hoàn thành xử lý hàng loạt!");
    } catch (err) {
      console.error(err);
      toast.error("Có lỗi xảy ra trong quá trình xử lý.");
    } finally {
      setIsProcessingBatch(false);
    }
  };

  const addBatchRule = () => {
    if (!newRule.original || !newRule.replacement) return;
    setBatchRules(prev => [...prev, { ...newRule, id: Date.now().toString() }]);
    setNewRule({ original: '', replacement: '', type: 'fixed' });
    toast.success("Đã thêm quy tắc mới!");
  };

  const removeBatchRule = (id: string) => {
    setBatchRules(prev => prev.filter(r => r.id !== id));
    toast.success("Đã xóa quy tắc!");
  };


  const mergePlaceholderChapters = (storyId: string) => {
    setLibrary(prev => {
      const updated = prev.map(story => {
        if (story.id === storyId) {
          const chapters = splitIntoChapters(story.content);
          if (chapters.length <= 1) return story;

          const mergedChapters: { title: string; content: string }[] = [];
          
          chapters.forEach((ch) => {
            // Check if this chapter is a placeholder (contains "-)")
            const isPlaceholder = ch.title.includes("-)");
            
            if (isPlaceholder && mergedChapters.length > 0) {
              // Merge with previous chapter
              // Remove the title line from the placeholder chapter content before merging
              const lines = ch.content.split('\n');
              if (lines.length > 0) lines.shift(); // Remove the title line
              
              mergedChapters[mergedChapters.length - 1].content += '\n' + lines.join('\n');
            } else {
              mergedChapters.push({ ...ch });
            }
          });

          const newContent = mergedChapters.map(ch => ch.content).join('\n\n');
          return { ...story, content: newContent };
        }
        return story;
      });
      return updated;
    });
    toast.success("Đã gộp các chương phụ (-)) thành công!");
  };

  const downloadStory = (story: SavedStory) => {
    toast.info(`Đang tải xuống: ${story.name}`);
    const blob = new Blob([story.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${story.name}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Tải xuống hoàn tất");
  };

  const downloadDecrypted = () => {
    if (!decryptedContent) return;
    toast.info("Đang tải xuống file đã giải mã...");
    const blob = new Blob([decryptedContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file ? file.name.replace('.gpg', '') : 'decrypted.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Tải xuống hoàn tất");
  };

  const reset = () => {
    setFile(null);
    setPassword('');
    setDecryptedContent(null);
    setError(null);
  };

  const saveApiKeys = () => {
    const geminiKeys = apiKeys;
    window.localStorage.setItem('gpg_api_keys', JSON.stringify(geminiKeys));

    const orKeys = openRouterKeyInput.split('\n').map(k => k.trim()).filter(k => k !== '');
    setOpenRouterKeys(orKeys);
    window.localStorage.setItem('gpg_openrouter_keys', JSON.stringify(orKeys));

    window.localStorage.setItem('gpg_ai_provider', aiProvider);
    window.localStorage.setItem('gpg_openrouter_model', openRouterModel);
    window.localStorage.setItem('gpg_gemini_model', geminiModel);
    window.localStorage.setItem('gpg_available_gemini_models', JSON.stringify(availableGeminiModels));
    window.localStorage.setItem('gpg_disabled_keys', JSON.stringify(disabledKeys));
    window.localStorage.setItem('gpg_glossary', JSON.stringify(glossary));
    window.localStorage.setItem('gpg_story_context', storyContext);

    const currentKeys = aiProvider === 'gemini' ? geminiKeys : orKeys;
    if (currentKeyIndexState >= currentKeys.length) {
      setCurrentKeyIndex(0);
    }
    setShowApiKeySettings(false);
    toast.success('Đã lưu cấu hình và tính nhất quán!');
  };

  const stableHandleSplitClick = useEvent(handleSplitClick);
  const stableOpenExportDialog = useEvent(openExportDialog);
  const stableFilterExtraDots = useEvent(filterExtraDots);
  const stableMergePlaceholderChapters = useEvent(mergePlaceholderChapters);
  const stableOptimizeLineBreaks = useEvent(optimizeLineBreaks);

  const applyCommonErrorsToStory = (storyId: string) => {
    const story = library.find(s => s.id === storyId);
    if (!story || !story.commonErrors || story.commonErrors.length === 0) {
      toast.error("Chưa có danh sách lỗi để sửa.");
      return;
    }

    setLibrary(prev => {
      const updated = prev.map(s => {
        if (s.id === storyId) {
          let newContent = s.content;
          // Sort by length descending
          const sorted = [...story.commonErrors!].sort((a, b) => b.o.length - a.o.length);
          let count = 0;
          sorted.forEach(c => {
            const escapedOriginal = c.o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedOriginal, 'g');
            const matches = newContent.match(regex);
            if (matches) count += matches.length;
            newContent = newContent.replace(regex, c.n);
          });
          toast.success(`Đã sửa xong ${count} vị trí lỗi trong toàn bộ truyện!`);
          return { ...s, content: newContent };
        }
        return s;
      });
      return updated;
    });
  };

  const handleEditCommonErrors = (storyId: string) => {
    const story = library.find(s => s.id === storyId);
    if (!story) return;
    
    const rawText = (story.commonErrors || []).map(err => `${err.o}|${err.n}`).join('\n');
    setEditErrorsDialog({ isOpen: true, storyId, rawText });
  };

  const saveCommonErrors = () => {
    const { storyId, rawText } = editErrorsDialog;
    const lines = rawText.split('\n').filter(line => line.trim() && line.includes('|'));
    const newErrors = lines.map(line => {
      const parts = line.split('|').map(s => s.trim());
      return { o: parts[0], n: parts[1] || '' };
    });

    setLibrary(prev => prev.map(s => {
      if (s.id === storyId) {
        return { ...s, commonErrors: newErrors };
      }
      return s;
    }));

    toast.success("Đã cập nhật danh sách lỗi!");
    setEditErrorsDialog(prev => ({ ...prev, isOpen: false }));
  };
  const stableDeleteFromLibrary = useEvent(deleteFromLibrary);
  const stableHandleChapterClick = useEvent(handleChapterClick);
  const stableDownloadChapter = useEvent(downloadChapter);
  const stableDownloadChapterPdf = useEvent(downloadChapterAsPdf);
  const stableHandleRenameChapterClick = useEvent((storyId: string, chapterIdx: number, oldTitle: string) => {
    setRenameChapterDialog({
      isOpen: true,
      storyId,
      chapterIdx,
      oldTitle,
      newTitle: oldTitle
    });
  });

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans p-4 md:p-8 flex items-center justify-center">
      <div className="max-w-3xl w-full space-y-8">
        <header className="text-center space-y-2">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="inline-flex items-center justify-center p-3 bg-[#141414] text-[#E4E3E0] rounded-full mb-4"
          >
            <Shield className="w-8 h-8" />
          </motion.div>
          <h1 className="text-4xl font-bold tracking-tighter uppercase italic font-serif">GPG Decryptor</h1>
          <p className="text-sm opacity-60 font-mono">Giải mã & Xử lý truyện an toàn</p>
          
          <div className="flex justify-center pt-4 gap-4 flex-wrap">
            <div className="flex items-center px-3 py-1 bg-[#141414]/5 border border-[#141414]/10 text-[10px] font-mono uppercase">
              <RefreshCw className="w-3 h-3 mr-2 opacity-40" />
              Token hôm nay: <span className="ml-2 font-bold text-blue-600">{dailyTokens.toLocaleString()}</span>
            </div>

            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowApiKeySettings(!showApiKeySettings)}
              className={cn(
                "text-[10px] font-mono uppercase border-[#141414]/20 rounded-none",
                (aiProvider === 'gemini' ? apiKeys.length > 0 : openRouterKeys.length > 0) ? "text-green-600 border-green-600/30" : "opacity-60"
              )}
            >
              <Key className="w-3 h-3 mr-2" />
              {aiProvider === 'gemini' 
                ? (apiKeys.length > 0 ? `Gemini: Key #${currentKeyIndexState + 1}/${apiKeys.length}` : "Cấu hình Gemini")
                : (openRouterKeys.length > 0 ? `OpenRouter: Key #${currentKeyIndexState + 1}/${openRouterKeys.length}` : "Cấu hình OpenRouter")
              }
            </Button>
          </div>
        </header>

        <AnimatePresence>
          {showApiKeySettings && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <Card className="border-[#141414] border-2 shadow-none bg-white mb-8">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono flex items-center gap-2">
                    <Key className="w-4 h-4" />
                    QUẢN LÝ API KEY (BULK)
                  </CardTitle>
                  <CardDescription className="text-[10px] font-mono">
                    Nhập danh sách API Key (mỗi dòng một key). Hệ thống sẽ tự động chuyển đổi khi hết hạn hoặc bị giới hạn (Rate Limit).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <Tabs defaultValue="api" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 mb-4">
                      <TabsTrigger value="api" className="text-[10px] font-mono uppercase">API Cấu Hình</TabsTrigger>
                      <TabsTrigger value="consistency" className="text-[10px] font-mono uppercase">Tính Nhất Quán</TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="api" className="space-y-6">
                      <div className="space-y-3">
                    <Label className="text-[10px] font-mono uppercase opacity-60">Chọn nhà cung cấp AI mặc định</Label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="radio" 
                          name="aiProvider" 
                          value="gemini" 
                          checked={aiProvider === 'gemini'} 
                          onChange={() => setAiProvider('gemini')}
                          className="accent-[#141414]"
                        />
                        <span className="text-xs font-mono uppercase">Gemini (Google)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="radio" 
                          name="aiProvider" 
                          value="openrouter" 
                          checked={aiProvider === 'openrouter'} 
                          onChange={() => setAiProvider('openrouter')}
                          className="accent-[#141414]"
                        />
                        <span className="text-xs font-mono uppercase">OpenRouter (GPT/Claude/...)</span>
                      </label>
                    </div>
                  </div>

                  {aiProvider === 'gemini' ? (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-[10px] font-mono uppercase opacity-60">Thêm Gemini API Key</Label>
                        <div className="flex gap-2">
                          <Input 
                            placeholder="Nhập Gemini API Key tại đây..."
                            value={newGeminiKey}
                            onChange={(e) => setNewGeminiKey(e.target.value)}
                            className="font-mono text-xs h-8 rounded-none border-[#141414]/20 focus:border-[#141414]"
                          />
                          <Button 
                            onClick={addGeminiKey}
                            size="sm"
                            className="h-8 rounded-none text-[10px] font-mono uppercase"
                          >
                            Thêm Key
                          </Button>
                        </div>
                      </div>
                      
                      {apiKeys.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-[9px] font-mono uppercase opacity-40">Danh sách Key hiện có:</Label>
                            <Button 
                              variant="outline" 
                              size="sm" 
                              onClick={() => scanGeminiModels(apiKeys[currentKeyIndexState] || apiKeys[0])}
                              disabled={isScanningModels}
                              className="h-6 text-[8px] font-mono uppercase rounded-none border-blue-600 text-blue-600 hover:bg-blue-50"
                            >
                              {isScanningModels ? "Đang quét..." : "Quét Model"}
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 gap-1">
                            {apiKeys.map((key, i) => {
                              const isDisabled = disabledKeys.includes(key);
                              return (
                                <div key={`gemini-key-${key}-${i}`} className={cn(
                                  "text-[9px] font-mono flex justify-between items-center p-2 border transition-colors",
                                  currentKeyIndexState === i ? "bg-green-50 border-green-200" : "bg-white border-[#141414]/10",
                                  isDisabled && "opacity-50 grayscale"
                                )}>
                                  <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "w-4 h-4 rounded-full flex items-center justify-center text-[8px]",
                                        currentKeyIndexState === i ? "bg-green-600 text-white" : "bg-[#141414]/10 text-[#141414]/40"
                                      )}>{i + 1}</span>
                                      <span className={isDisabled ? "line-through" : ""}>{key.substring(0, 8)}...{key.substring(key.length - 4)}</span>
                                    </div>
                                    {keyStatuses[key] && (
                                      <div className={cn(
                                        "text-[8px] font-bold px-1 py-0.5 rounded-sm",
                                        keyStatuses[key].status === 'success' ? "text-green-600 bg-green-100" : 
                                        keyStatuses[key].status === 'testing' ? "text-blue-600 bg-blue-100 animate-pulse" :
                                        "text-red-600 bg-red-100"
                                      )}>
                                        {keyStatuses[key].message}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex gap-1">
                                    <Button 
                                      size="sm" 
                                      variant="ghost"
                                      onClick={() => {
                                        if (isDisabled) {
                                          setDisabledKeys(prev => prev.filter(k => k !== key));
                                        } else {
                                          setDisabledKeys(prev => [...prev, key]);
                                        }
                                      }}
                                      className="h-6 text-[8px] font-mono uppercase rounded-none px-2"
                                    >
                                      {isDisabled ? "Bật" : "Tắt"}
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => testApiKey(key, 'gemini')}
                                      className="h-6 text-[8px] font-mono uppercase rounded-none px-2 border-blue-600 text-blue-600 hover:bg-blue-50"
                                    >
                                      Thử (100 Token)
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant={currentKeyIndexState === i ? "default" : "outline"}
                                      disabled={isDisabled}
                                      onClick={() => setCurrentKeyIndex(i)}
                                      className={cn(
                                        "h-6 text-[8px] font-mono uppercase rounded-none px-2",
                                        currentKeyIndexState === i ? "bg-green-600 hover:bg-green-700" : ""
                                      )}
                                    >
                                      {currentKeyIndexState === i ? "Đang dùng" : "Sử dụng"}
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant="ghost"
                                      onClick={() => {
                                        const newKeys = apiKeys.filter((_, index) => index !== i);
                                        setApiKeys(newKeys);
                                        if (currentKeyIndexState >= newKeys.length) {
                                          setCurrentKeyIndex(Math.max(0, newKeys.length - 1));
                                        }
                                      }}
                                      className="h-6 text-[8px] font-mono uppercase rounded-none px-2 text-red-600 hover:bg-red-50"
                                    >
                                      Xóa
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label className="text-[10px] font-mono uppercase opacity-60">Model Gemini</Label>
                        <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto custom-scrollbar p-1 border border-[#141414]/10">
                          {availableGeminiModels.map(m => (
                            <button 
                              key={m}
                              onClick={() => setGeminiModel(m)}
                              className={cn(
                                "text-[8px] font-mono px-2 py-1 border transition-colors",
                                geminiModel === m ? "bg-[#141414] text-white border-[#141414]" : "bg-white text-[#141414] border-[#141414]/20 hover:bg-[#141414]/5"
                              )}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-[10px] font-mono uppercase opacity-60">Model OpenRouter (Ví dụ: openai/gpt-4o, anthropic/claude-3-sonnet)</Label>
                        <Input 
                          placeholder="openai/gpt-4o"
                          value={openRouterModel}
                          onChange={(e) => setOpenRouterModel(e.target.value)}
                          className="font-mono text-xs h-8 rounded-none border-[#141414]/20 focus:border-[#141414]"
                        />
                        <p className="text-[9px] font-mono opacity-50">
                          Gợi ý model miễn phí: <br/>
                          - google/gemini-2.0-flash-lite-preview-02-05:free <br/>
                          - google/gemini-2.0-pro-exp-02-05:free <br/>
                          - deepseek/deepseek-chat:free <br/>
                          - meta-llama/llama-3.3-70b-instruct:free
                        </p>
                        <div className="flex flex-wrap gap-1 pt-1">
                          {['google/gemini-2.0-flash-lite-preview-02-05:free', 'deepseek/deepseek-chat:free', 'meta-llama/llama-3.3-70b-instruct:free'].map(m => (
                            <button 
                              key={m}
                              onClick={() => setOpenRouterModel(m)}
                              className={cn(
                                "text-[8px] font-mono px-1.5 py-0.5 border transition-colors",
                                openRouterModel === m ? "bg-[#141414] text-white border-[#141414]" : "bg-[#141414]/5 text-[#141414] border-[#141414]/10 hover:bg-[#141414]/10"
                              )}
                            >
                              {m.split('/')[1].split(':')[0]}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] font-mono uppercase opacity-60">Danh sách OpenRouter API Keys</Label>
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            onClick={checkApiKeyBalances}
                            disabled={isCheckingBalance || openRouterKeys.length === 0}
                            className="h-6 text-[9px] font-mono uppercase hover:bg-blue-50 text-blue-600"
                          >
                            {isCheckingBalance ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
                            Kiểm tra số dư
                          </Button>
                        </div>
                        <Textarea 
                          placeholder="Nhập OpenRouter API Key tại đây...&#10;sk-or-v1-..."
                          value={openRouterKeyInput}
                          onChange={(e) => setOpenRouterKeyInput(e.target.value)}
                          className="font-mono text-xs min-h-[100px] rounded-none border-[#141414]/20 focus:border-[#141414]"
                        />
                        {openRouterKeys.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <Label className="text-[9px] font-mono uppercase opacity-40">Danh sách Key hiện có:</Label>
                            <div className="grid grid-cols-1 gap-1">
                              {openRouterKeys.map((key, i) => {
                                const isDisabled = disabledKeys.includes(key);
                                return (
                                  <div key={`or-key-${key}-${i}`} className={cn(
                                    "text-[9px] font-mono flex justify-between items-center p-2 border transition-colors",
                                    currentKeyIndexState === i ? "bg-blue-50 border-blue-200" : "bg-white border-[#141414]/10",
                                    isDisabled && "opacity-50 grayscale"
                                  )}>
                                    <div className="flex flex-col gap-1">
                                      <div className="flex items-center gap-2">
                                        <span className={cn(
                                          "w-4 h-4 rounded-full flex items-center justify-center text-[8px]",
                                          currentKeyIndexState === i ? "bg-blue-600 text-white" : "bg-[#141414]/10 text-[#141414]/40"
                                        )}>{i + 1}</span>
                                        <span className={isDisabled ? "line-through" : ""}>{key.substring(0, 12)}...</span>
                                      </div>
                                      {keyStatuses[key] ? (
                                        <div className={cn(
                                          "text-[8px] font-bold px-1 py-0.5 rounded-sm",
                                          keyStatuses[key].status === 'success' ? "text-green-600 bg-green-100" : 
                                          keyStatuses[key].status === 'testing' ? "text-blue-600 bg-blue-100 animate-pulse" :
                                          "text-red-600 bg-red-100"
                                        )}>
                                          {keyStatuses[key].message}
                                        </div>
                                      ) : (
                                        keyBalances[key] && (
                                          <span className="text-[8px] text-blue-600 font-bold ml-6">Số dư: {keyBalances[key]}</span>
                                        )
                                      )}
                                    </div>
                                    <div className="flex gap-1">
                                      <Button 
                                        size="sm" 
                                        variant="ghost"
                                        onClick={() => {
                                          if (isDisabled) {
                                            setDisabledKeys(prev => prev.filter(k => k !== key));
                                          } else {
                                            setDisabledKeys(prev => [...prev, key]);
                                          }
                                        }}
                                        className="h-6 text-[8px] font-mono uppercase rounded-none px-2"
                                      >
                                        {isDisabled ? "Bật" : "Tắt"}
                                      </Button>
                                      <Button 
                                        size="sm" 
                                        variant="outline"
                                        onClick={() => testApiKey(key, 'openrouter')}
                                        className="h-6 text-[8px] font-mono uppercase rounded-none px-2 border-blue-600 text-blue-600 hover:bg-blue-50"
                                      >
                                        Thử
                                      </Button>
                                      <Button 
                                        size="sm" 
                                        variant={currentKeyIndexState === i ? "default" : "outline"}
                                        disabled={isDisabled}
                                        onClick={() => setCurrentKeyIndex(i)}
                                        className={cn(
                                          "h-6 text-[8px] font-mono uppercase rounded-none px-2",
                                          currentKeyIndexState === i ? "bg-blue-600 hover:bg-blue-700" : ""
                                        )}
                                      >
                                        {currentKeyIndexState === i ? "Đang dùng" : "Sử dụng"}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                    </TabsContent>

                    <TabsContent value="consistency" className="space-y-6">
                      <div className="space-y-2">
                        <Label className="text-[10px] font-mono uppercase opacity-60">Bối cảnh truyện (Story Context)</Label>
                        <Textarea 
                          placeholder="Ví dụ: Truyện tu tiên, nhân vật chính là Lâm Phàm, tính cách lạnh lùng, có một con pet là rồng đen..."
                          value={storyContext}
                          onChange={(e) => setStoryContext(e.target.value)}
                          className="font-mono text-xs min-h-[80px] rounded-none border-[#141414]/20 focus:border-[#141414]"
                        />
                        <p className="text-[9px] font-mono opacity-50 italic">Cung cấp bối cảnh giúp AI dịch sát nghĩa và đúng văn phong hơn.</p>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] font-mono uppercase opacity-60">Từ điển (Glossary)</Label>
                          <Button 
                            size="sm" 
                            variant="outline" 
                            onClick={() => setGlossary([...glossary, { original: '', translated: '' }])}
                            className="h-6 text-[9px] font-mono uppercase border-[#141414]/20 hover:bg-[#141414]/5"
                          >
                            + Thêm từ
                          </Button>
                        </div>
                        
                        <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                          {glossary.length === 0 ? (
                            <div className="text-center py-4 border border-dashed border-[#141414]/10">
                              <p className="text-[10px] font-mono opacity-40">Chưa có từ nào trong từ điển.</p>
                            </div>
                          ) : (
                            glossary.map((item, idx) => (
                              <div key={`glossary-${idx}`} className="flex gap-2 items-center">
                                <Input 
                                  placeholder="Từ gốc"
                                  value={item.original}
                                  onChange={(e) => {
                                    const newG = [...glossary];
                                    newG[idx].original = e.target.value;
                                    setGlossary(newG);
                                  }}
                                  className="font-mono text-[10px] h-8 rounded-none border-[#141414]/20"
                                />
                                <ArrowRight className="w-3 h-3 opacity-30 shrink-0" />
                                <Input 
                                  placeholder="Dịch"
                                  value={item.translated}
                                  onChange={(e) => {
                                    const newG = [...glossary];
                                    newG[idx].translated = e.target.value;
                                    setGlossary(newG);
                                  }}
                                  className="font-mono text-[10px] h-8 rounded-none border-[#141414]/20"
                                />
                                <Button 
                                  size="icon" 
                                  variant="ghost" 
                                  onClick={() => setGlossary(glossary.filter((_, i) => i !== idx))}
                                  className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                        <p className="text-[9px] font-mono opacity-50 italic">Dùng để cố định cách dịch các danh từ riêng, chiêu thức, địa danh...</p>
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div className="flex justify-end gap-2 pt-2 border-t border-[#141414]/10">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setShowApiKeySettings(false)}
                      className="text-[10px] font-mono uppercase"
                    >
                      Hủy
                    </Button>
                    <Button 
                      size="sm" 
                      onClick={saveApiKeys}
                      className="bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 rounded-none text-[10px] font-mono uppercase"
                    >
                      Lưu cấu hình
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 bg-[#141414]/5 p-1 rounded-none border-2 border-[#141414]">
            <TabsTrigger value="decrypt" className="rounded-none font-mono uppercase text-[10px] md:text-xs data-[state=active]:bg-[#141414] data-[state=active]:text-[#E4E3E0]">
              <Unlock className="w-4 h-4 mr-2 hidden sm:inline" />
              Giải mã
            </TabsTrigger>
            <TabsTrigger value="library" className="rounded-none font-mono uppercase text-[10px] md:text-xs data-[state=active]:bg-[#141414] data-[state=active]:text-[#E4E3E0]">
              <Library className="w-4 h-4 mr-2 hidden sm:inline" />
              Thư viện ({library.length})
            </TabsTrigger>
            <TabsTrigger value="convert" className="rounded-none font-mono uppercase text-[10px] md:text-xs data-[state=active]:bg-[#141414] data-[state=active]:text-[#E4E3E0]">
              <Sparkles className="w-4 h-4 mr-2 hidden sm:inline" />
              Biên dịch AI
            </TabsTrigger>
          </TabsList>

          <TabsContent value="decrypt" className="space-y-6 mt-6">
            <Card className="border-[#141414] border-2 shadow-none bg-white/50 backdrop-blur-sm">
              <CardHeader className="border-b border-[#141414] pb-4">
                <CardTitle className="text-lg font-mono flex items-center gap-2">
                  <Unlock className="w-4 h-4" />
                  THÔNG TIN GIẢI MÃ
                </CardTitle>
                <CardDescription className="font-mono text-xs opacity-60">
                  Dữ liệu của bạn được xử lý cục bộ, không bao giờ rời khỏi trình duyệt.
                </CardDescription>
              </CardHeader>
              
              <CardContent className="pt-6 space-y-6">
                <div className="space-y-2">
                  <Label className="text-xs font-mono uppercase opacity-60">1. Chọn file .gpg hoặc .txt</Label>
                  <div 
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    className={cn(
                      "relative border-2 border-dashed border-[#141414]/20 rounded-lg p-8 transition-all duration-200 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-[#141414]/40 hover:bg-[#141414]/5",
                      isDragging && "border-[#141414] bg-[#141414]/10",
                      file && "border-solid border-[#141414]/40 bg-[#141414]/5"
                    )}
                    onClick={() => document.getElementById('file-upload')?.click()}
                  >
                    <input 
                      id="file-upload" 
                      type="file" 
                      className="hidden" 
                      accept=".gpg,.txt"
                      onChange={handleFileChange}
                    />
                    {file ? (
                      <div className="flex items-center gap-3">
                        <FileText className="w-8 h-8 text-[#141414]" />
                        <div className="text-left">
                          <p className="font-mono text-sm font-bold">{file.name}</p>
                          <p className="font-mono text-xs opacity-50">{(file.size / 1024).toFixed(2)} KB</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <UploadCloud className="w-10 h-10 opacity-20" />
                        <p className="font-mono text-xs opacity-50">Kéo thả file .gpg hoặc .txt vào đây hoặc click để chọn</p>
                      </>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-xs font-mono uppercase opacity-60">2. Nhập mật khẩu (Bỏ qua nếu là file .txt)</Label>
                  <Input 
                    id="password"
                    type="password"
                    placeholder="Nhập mật khẩu giải mã..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="border-[#141414] focus-visible:ring-0 focus-visible:border-2 rounded-none font-mono"
                    disabled={file?.name.toLowerCase().endsWith('.txt')}
                  />
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="p-3 bg-red-50 border border-red-200 text-red-600 rounded flex items-center gap-2 text-sm font-mono"
                    >
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{error}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>

              <CardFooter className="border-t border-[#141414] pt-4 flex gap-3">
                <Button 
                  onClick={decryptFile}
                  disabled={!file || (!password && !file.name.toLowerCase().endsWith('.txt')) || isDecrypting}
                  className="flex-1 bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 rounded-none font-mono uppercase tracking-widest h-12"
                >
                  {isDecrypting ? (
                    <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Unlock className="w-4 h-4 mr-2" />
                  )}
                  {isDecrypting ? 'ĐANG XỬ LÝ...' : 'ĐỌC FILE'}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={reset}
                  className="border-[#141414] hover:bg-[#141414] hover:text-[#E4E3E0] rounded-none font-mono uppercase h-12"
                >
                  LÀM MỚI
                </Button>
              </CardFooter>
            </Card>

            <AnimatePresence>
              {decryptedContent && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-4"
                >
                  <Card className="border-[#141414] border-2 shadow-none bg-white">
                    <CardHeader className="border-b border-[#141414] pb-4">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <CardTitle className="text-lg font-mono flex items-center gap-2">
                            <FileText className="w-5 h-5" />
                            KẾT QUẢ GIẢI MÃ
                          </CardTitle>
                          <CardDescription className="font-mono text-xs opacity-60">
                            Vui lòng kiểm tra nội dung trước khi lưu vào kho lưu trữ.
                          </CardDescription>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <div className="w-full mb-2">
                            {isFixingAI && (
                              <div className="w-full bg-[#141414] h-1 mb-2 overflow-hidden">
                                <motion.div 
                                  className="bg-purple-500 h-full"
                                  initial={{ width: 0 }}
                                  animate={{ width: `${aiProgress}%` }}
                                  transition={{ duration: 0.3 }}
                                />
                              </div>
                            )}
                          </div>
                          <Button 
                            size="sm" 
                            onClick={combinedSmartFixAI}
                            disabled={isFixingAI || (aiProvider === 'gemini' ? apiKeys.length === 0 : openRouterKeys.length === 0)}
                            className="bg-purple-600 text-white hover:bg-purple-700 rounded-none font-mono uppercase text-xs h-10 px-4 disabled:opacity-50"
                          >
                            {isFixingAI ? (
                              <>
                                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                                ĐANG XỬ LÝ {aiProgress}%
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-4 h-4 mr-2" />
                                XỬ LÝ TOÀN DIỆN (AI)
                              </>
                            )}
                          </Button>
                          
                          <Button 
                            size="sm" 
                            onClick={cleanupTrash}
                            className="bg-amber-600 text-white hover:bg-amber-700 rounded-none font-mono uppercase text-xs h-10 px-4"
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            DỌN RÁC (LỌC DỊCH GIẢ, TRÙNG LẶP, SỬA LỖI)
                          </Button>
                          <Button 
                            size="sm" 
                            variant="outline"
                            onClick={reset}
                            className="border-[#141414] hover:bg-[#141414] hover:text-[#E4E3E0] rounded-none font-mono uppercase text-xs h-10 px-4"
                          >
                            LÀM MỚI
                          </Button>
                          <Button 
                            size="sm" 
                            onClick={saveToLibrary}
                            className="bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 rounded-none font-mono uppercase text-xs h-10 px-4"
                          >
                            <Save className="w-4 h-4 mr-2" />
                            LƯU VÀO KHO & TÁCH CHƯƠNG
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    
                    <CardContent className="pt-6 space-y-6">
                      {/* Find and Replace UI */}
                      <div className="bg-[#141414]/5 p-4 border border-[#141414]/10 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-xs font-mono font-bold uppercase opacity-60">
                            <Search className="w-3 h-3" />
                            Lọc và Thay thế (Áp dụng cho tất cả file)
                          </div>
                          <div className="flex gap-2">
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-[10px] font-mono uppercase opacity-50">Tìm đoạn văn bản</Label>
                            <Input 
                              placeholder="Ví dụ: Tên nhóm dịch..."
                              value={findText}
                              onChange={(e) => setFindText(e.target.value)}
                              className="h-8 text-xs border-[#141414]/20 rounded-none font-mono"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[10px] font-mono uppercase opacity-50">Thay thế bằng (để trống để xóa)</Label>
                            <Input 
                              placeholder="Thay thế bằng..."
                              value={replaceText}
                              onChange={(e) => setReplaceText(e.target.value)}
                              className="h-8 text-xs border-[#141414]/20 rounded-none font-mono"
                            />
                          </div>
                        </div>
                        <Button 
                          size="sm" 
                          onClick={handleReplace}
                          disabled={!findText}
                          className="w-full bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 rounded-none font-mono uppercase text-[10px] h-8"
                        >
                          <Replace className="w-3 h-3 mr-2" />
                          THỰC THI THAY THẾ TRÊN TẤT CẢ FILE CHƯƠNG
                        </Button>
                      </div>

                      {/* Full Text Preview (Limited for performance) */}
                      <div className="space-y-2">
                        <Label className="text-xs font-mono uppercase opacity-60 flex justify-between">
                          <span>Nội dung đã giải mã</span>
                          {decryptedContent && decryptedContent.length > 20000 && (
                            <span className="text-red-500 lowercase italic">Đang hiển thị 20,000 ký tự đầu tiên để tránh lag...</span>
                          )}
                        </Label>
                        <div className="h-[400px] w-full border border-[#141414]/20 p-4 bg-[#F9F8F6] font-mono text-sm leading-relaxed whitespace-pre-wrap overflow-y-auto custom-scrollbar">
                          {typeof decryptedContent === 'string' ? (decryptedContent.length > 20000 ? decryptedContent.substring(0, 20000) + "\n\n... [Nội dung còn tiếp, vui lòng lưu vào kho để xem đầy đủ] ..." : decryptedContent) : ''}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="library" className="mt-6">
            {activeTab === 'library' && (
              <Card className="border-[#141414] border-2 shadow-none bg-white">
              <CardHeader className="border-b border-[#141414] pb-4">
                <CardTitle className="text-lg font-mono flex items-center gap-2">
                  <Library className="w-4 h-4" />
                  KHO TRUYỆN ĐÃ DỊCH
                </CardTitle>
                <CardDescription className="font-mono text-xs opacity-60">
                  Danh sách các bộ truyện bạn đã xử lý và lưu trữ.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="h-[500px] overflow-y-auto custom-scrollbar">
                  {library.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-[400px] opacity-20 space-y-4">
                      <BookOpen className="w-16 h-16" />
                      <p className="font-mono uppercase tracking-widest text-sm">Kho trống</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-[#141414]/10">
                      {library.map((story) => (
                        <StoryItem 
                          key={`lib-${story.id}`}
                          story={story}
                          isExpanded={expandedStoryId === story.id}
                          isScanningThisStory={isScanning === story.id}
                          isProcessingPart={isProcessingPart}
                          splitIntoChapters={splitIntoChapters}
                          customPrefix={customPrefix}
                          isStrictMode={isStrictMode}
                          onExpand={setExpandedStoryId}
                          onSplitClick={stableHandleSplitClick}
                          onExportDialog={stableOpenExportDialog}
                          onFilterDots={stableFilterExtraDots}
                          onRenumberDialog={setRenumberDialog}
                          onMergeChapters={stableMergePlaceholderChapters}
                          onOptimizeLineBreaks={stableOptimizeLineBreaks}
                          onApplyCommonErrors={applyCommonErrorsToStory}
                          onEditCommonErrors={handleEditCommonErrors}
                          onDelete={stableDeleteFromLibrary}
                          setCustomPrefix={setCustomPrefix}
                          setIsStrictMode={setIsStrictMode}
                          onChapterClick={stableHandleChapterClick}
                          onRenameChapterClick={stableHandleRenameChapterClick}
                          onDownloadChapter={stableDownloadChapter}
                          onDownloadChapterPdf={stableDownloadChapterPdf}
                          onAddToGlossary={handleAddToGlossary}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="convert" className="mt-6 space-y-6">
            {activeTab === 'convert' && (
              <Card className="border-[#141414] border-2 shadow-none bg-white">
              <CardHeader className="border-b border-[#141414] pb-4">
                <CardTitle className="text-lg font-mono flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-600" />
                  BIÊN DỊCH & CHUYỂN ĐỔI AI
                </CardTitle>
                <CardDescription className="font-mono text-xs opacity-60">
                  Chọn truyện từ kho lưu trữ để bắt đầu biên dịch lại bằng AI.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div className="flex flex-col sm:flex-row gap-2 items-center bg-[#141414]/5 p-2 border border-[#141414]/10">
                  <div className="flex-1 w-full">
                    <select 
                      value={selectedConvertStoryId || ''}
                      onChange={(e) => {
                        setSelectedConvertStoryId(e.target.value || null);
                        setSelectedConvertChapterIdx(null);
                      }}
                      className="w-full bg-white border border-[#141414]/20 h-9 px-3 font-mono text-[11px] outline-none focus:border-[#141414] transition-colors"
                    >
                      <option value="">-- CHỌN TRUYỆN --</option>
                      {library.map(story => (
                        <option key={`opt-${story.id}`} value={story.id}>{story.name}</option>
                      ))}
                    </select>
                  </div>
                  {selectedConvertStoryId && (
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button 
                        size="sm"
                        onClick={() => {
                          const story = library.find(s => s.id === selectedConvertStoryId);
                          if (story) openExportDialog(story, 'txt', true);
                        }}
                        className="h-9 font-mono text-[10px] uppercase bg-green-600 hover:bg-green-700 text-white rounded-none px-4 flex-1 sm:flex-none"
                      >
                        <FileText className="w-3 h-3 mr-2" />
                        Tải TXT
                      </Button>
                      <Button 
                        size="sm"
                        onClick={() => {
                          const story = library.find(s => s.id === selectedConvertStoryId);
                          if (story) openExportDialog(story, 'pdf', true);
                        }}
                        className="h-9 font-mono text-[10px] uppercase bg-red-600 hover:bg-red-700 text-white rounded-none px-4 flex-1 sm:flex-none"
                      >
                        <FileDown className="w-3 h-3 mr-2" />
                        Tải PDF
                      </Button>
                      <Button 
                        size="sm"
                        onClick={() => {
                          const story = library.find(s => s.id === selectedConvertStoryId);
                          if (story) openExportDialog(story, 'docx', true);
                        }}
                        className="h-9 font-mono text-[10px] uppercase bg-blue-600 hover:bg-blue-700 text-white rounded-none px-4 flex-1 sm:flex-none"
                      >
                        <FileText className="w-3 h-3 mr-2" />
                        Tải WORD
                      </Button>
                    </div>
                  )}
                </div>

                {selectedConvertStoryId && (
                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 pt-2">
                    {/* Left: Chapter List */}
                    <div className="lg:col-span-1 space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <Label className="text-[9px] font-mono uppercase opacity-50">Chương</Label>
                        <div className="flex flex-col gap-2">
                          <div className="space-y-1">
                            <Label className="text-[8px] font-mono uppercase opacity-50">Thể loại truyện</Label>
                            <div className="flex flex-wrap gap-1">
                              {GENRE_OPTIONS.map(genre => (
                                <button
                                  key={genre}
                                  onClick={() => toggleGenre(genre)}
                                  className={cn(
                                    "px-1.5 py-0.5 text-[8px] font-mono border transition-colors",
                                    selectedGenres.includes(genre) 
                                      ? "bg-[#141414] text-white border-[#141414]" 
                                      : "bg-white text-[#141414] border-[#141414]/20 hover:bg-[#141414]/5"
                                  )}
                                >
                                  {genre}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[8px] font-mono uppercase opacity-50">Phong cách dịch</Label>
                            <div className="flex flex-wrap gap-1">
                              {STYLE_OPTIONS.map(style => (
                                <button
                                  key={style}
                                  onClick={() => toggleStyle(style)}
                                  className={cn(
                                    "px-1.5 py-0.5 text-[8px] font-mono border transition-colors",
                                    selectedStyles.includes(style) 
                                      ? "bg-purple-600 text-white border-purple-600" 
                                      : "bg-white text-[#141414] border-[#141414]/20 hover:bg-purple-50"
                                  )}
                                >
                                  {style}
                                </button>
                              ))}
                            </div>
                          </div>
                          {aiProvider === 'openrouter' && (
                            <div className="flex items-center gap-1 text-[8px] font-mono text-amber-600 animate-pulse mt-1">
                              <AlertCircle className="w-2 h-2" />
                              Dùng :free nếu hết tiền
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="h-[500px] border border-[#141414]/20 bg-white overflow-y-auto custom-scrollbar">
                        <div className="divide-y divide-[#141414]/5">
                          {currentConvertChapters.map((ch, idx) => {
                            const isConverted = currentConvertStory?.convertedChapters && currentConvertStory.convertedChapters[idx];
                            return (
                              <div 
                                key={`conv-ch-${idx}`}
                                onClick={() => setSelectedConvertChapterIdx(idx)}
                                className={cn(
                                  "p-2 cursor-pointer transition-colors flex items-center justify-between group",
                                  selectedConvertChapterIdx === idx ? "bg-[#141414] text-white" : "hover:bg-[#141414]/5"
                                )}
                              >
                                <div className="flex flex-col overflow-hidden">
                                  <span className="text-[7px] font-mono opacity-40 uppercase">C.{idx + 1}</span>
                                  <span className="text-[9px] font-mono font-bold truncate">{ch.title}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {isConverted && (
                                    <div className="bg-green-500 text-white p-0.5 rounded-full">
                                      <RefreshCw className="w-2 h-2" />
                                    </div>
                                  )}
                                  {!isConverted && idx >= skipChaptersCount && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSkipChaptersCount(idx);
                                        toast.info(`Sẽ bỏ qua đến chương ${idx + 1}`);
                                      }}
                                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                      title="Bỏ qua đến chương này"
                                    >
                                      <Scissors className="w-3 h-3" />
                                    </Button>
                                  )}
                                  {idx < skipChaptersCount && (
                                    <div className="text-[7px] font-mono opacity-40 uppercase border border-[#141414]/20 px-1">
                                      Bỏ qua
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Right: Split View */}
                    <div className="lg:col-span-3 space-y-3">
                      {selectedConvertChapterIdx !== null ? (
                        <div className="space-y-3 h-full flex flex-col">
                          <div className="flex items-center justify-between px-1">
                            <Label className="text-[9px] font-mono uppercase opacity-50">
                              Chương {selectedConvertChapterIdx + 1}
                            </Label>
                            <div className="flex gap-2 items-center flex-wrap">
                              {(aiProvider === 'gemini' ? apiKeys.length === 0 : openRouterKeys.length === 0) && (
                                <span className="text-[9px] font-mono text-red-500 animate-pulse mr-2">
                                  ⚠️ Vui lòng thêm API Key để biên dịch
                                </span>
                              )}
                              {!isAutoConverting && (
                                <>
                                  <div className="flex items-center gap-1 mr-2">
                                    <span className="text-[8px] font-mono uppercase opacity-40">Chế độ:</span>
                                    <select 
                                      value={translationMode}
                                      onChange={(e) => setTranslationMode(e.target.value as any)}
                                      className="h-6 text-[9px] font-mono bg-white border border-[#141414]/20 rounded-none px-1 focus:outline-none"
                                    >
                                      <option value="quality">Dịch Chất lượng cao</option>
                                      <option value="fast">Dịch siêu tốc (Tiết kiệm)</option>
                                      <option value="proofread">Sửa lỗi trực tiếp (Tiết kiệm Token nhất)</option>
                                    </select>
                                  </div>
                                  <div className="flex items-center gap-1 mr-2">
                                    <span className="text-[8px] font-mono uppercase opacity-40">Song song:</span>
                                    <select 
                                      value={concurrency}
                                      onChange={(e) => setConcurrency(parseInt(e.target.value))}
                                      className="h-6 text-[9px] font-mono bg-white border border-[#141414]/20 rounded-none px-1 focus:outline-none"
                                    >
                                      <option value="1">1 ch</option>
                                      <option value="2">2 ch</option>
                                      <option value="3">3 ch</option>
                                      <option value="5">5 ch</option>
                                    </select>
                                  </div>
                                  <div className="flex items-center gap-1 mr-2">
                                    <span className="text-[8px] font-mono uppercase opacity-40">Bỏ qua:</span>
                                    <Input 
                                      type="number" 
                                      min="0"
                                      value={skipChaptersCount}
                                      onChange={(e) => setSkipChaptersCount(parseInt(e.target.value) || 0)}
                                      className="h-6 w-12 text-[9px] font-mono p-1 rounded-none border-[#141414]/20"
                                    />
                                    <span className="text-[8px] font-mono uppercase opacity-40">chương</span>
                                  </div>
                                </>
                              )}
                              {isAutoConverting ? (
                                <Button 
                                  size="sm"
                                  onClick={stopAutoConversion}
                                  className="h-7 text-[9px] font-mono uppercase bg-red-600 hover:bg-red-700 text-white rounded-none px-3"
                                >
                                  <Square className="w-2.5 h-2.5 mr-1.5" />
                                  Dừng dịch
                                </Button>
                              ) : (
                                <Button 
                                  size="sm"
                                  onClick={startAutoConversion}
                                  disabled={isProcessingPart || (aiProvider === 'gemini' ? apiKeys.length === 0 : openRouterKeys.length === 0)}
                                  className="h-7 text-[9px] font-mono uppercase bg-purple-600 hover:bg-purple-700 text-white rounded-none px-3 disabled:opacity-50"
                                >
                                  <RefreshCw className="w-2.5 h-2.5 mr-1.5" />
                                  Dịch tự động
                                </Button>
                              )}
                              <Button 
                                size="sm"
                                onClick={() => processSelectedChapter()}
                                disabled={isProcessingPart || isAutoConverting || (aiProvider === 'gemini' ? apiKeys.length === 0 : openRouterKeys.length === 0)}
                                className="h-7 text-[9px] font-mono uppercase bg-blue-600 hover:bg-blue-700 text-white rounded-none px-3 disabled:opacity-50"
                              >
                                {isProcessingPart ? <RefreshCw className="w-2.5 h-2.5 mr-1.5 animate-spin" /> : <Sparkles className="w-2.5 h-2.5 mr-1.5" />}
                                {isProcessingPart ? `Dịch ${partProgress}%` : 'Biên dịch'}
                              </Button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-[600px]">
                            {/* Original */}
                            <div className="flex flex-col border border-[#141414]/20 bg-white shadow-sm h-[500px] md:h-[600px]">
                              <div className="bg-[#141414] text-white px-2 py-0.5 text-[8px] font-mono uppercase">Văn bản gốc</div>
                              <div className="flex-1 p-3 overflow-auto scrollbar-thin scrollbar-thumb-[#141414]/20 touch-pan-y overscroll-contain">
                                <pre className="text-[11px] font-mono whitespace-pre-wrap opacity-60 leading-relaxed">
                                  {currentConvertChapters[selectedConvertChapterIdx]?.content || ""}
                                </pre>
                              </div>
                            </div>

                            {/* Converted */}
                            <div className="flex flex-col border border-[#141414]/20 bg-white shadow-sm h-[500px] md:h-[600px]">
                              <div className="bg-purple-600 text-white px-2 py-0.5 text-[8px] font-mono uppercase flex justify-between items-center">
                                  <div className="flex items-center gap-2">
                                    <span>Bản đã biên dịch</span>
                                    <div className="h-3 w-[1px] bg-white/20 mx-1" />
                                    <input 
                                      type="checkbox" 
                                      id="show-diff-toggle"
                                      checked={showDiff}
                                      onChange={(e) => setShowDiff(e.target.checked)}
                                      className="w-2.5 h-2.5 accent-yellow-400"
                                    />
                                    <Label htmlFor="show-diff-toggle" className="text-[7px] font-mono uppercase cursor-pointer opacity-80">So sánh</Label>
                                    {showDiff && (
                                      <div className="flex items-center gap-1 ml-1 px-1.5 py-0.5 bg-yellow-400 text-[#141414] rounded-full text-[7px] font-bold">
                                        <div className="w-1.5 h-1.5 bg-yellow-600 rounded-full animate-pulse" />
                                        DÒNG CÓ THAY ĐỔI
                                      </div>
                                    )}
                                  </div>
                                {(() => {
                                  const converted = currentConvertStory?.convertedChapters?.[selectedConvertChapterIdx];
                                  if (converted) {
                                    return (
                                      <div className="flex items-center gap-2">
                                        <Button 
                                          variant="ghost" 
                                          size="icon" 
                                          className="h-4 w-4 text-white hover:bg-white/20"
                                          onClick={() => {
                                            downloadChapter(`${currentConvertChapters[selectedConvertChapterIdx].title}_converted`, converted);
                                          }}
                                        >
                                          <Download className="w-2.5 h-2.5" />
                                        </Button>
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                              <div className="flex-1 p-3 bg-purple-50/30 overflow-auto scrollbar-thin scrollbar-thumb-purple-200 touch-pan-y overscroll-contain">
                                {(() => {
                                  const converted = currentConvertStory?.convertedChapters?.[selectedConvertChapterIdx];
                                  if (!converted) return <div className="h-full flex items-center justify-center text-[10px] font-mono opacity-30 italic">Chưa biên dịch chương này</div>;
                                  
                                  const original = currentConvertChapters[selectedConvertChapterIdx]?.content || "";
                                  
                                  return (
                                    <ConvertedView 
                                      original={original}
                                      converted={converted}
                                      showDiff={showDiff}
                                    />
                                  );
                                })()}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center border border-dashed border-[#141414]/10 opacity-20 space-y-3 min-h-[500px]">
                          <BookOpen className="w-12 h-12" />
                          <p className="font-mono uppercase tracking-widest text-[10px]">Chọn chương</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
        <footer className="text-center pt-8 border-t border-[#141414]/10 space-y-4">
          <p className="text-[10px] font-mono opacity-40 uppercase tracking-[0.2em]">
            © 2024 BIÊN DỊCH LẠI TRUYỆN CONVERTER • CLIENT-SIDE ONLY
          </p>
        </footer>
      </div>

      <Toaster position="top-right" richColors />
      <AnimatePresence>
        {saveStoryDialog.isOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <div className="bg-white border-2 border-[#141414] p-8 max-w-lg w-full space-y-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414] pb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  <Save className="w-5 h-5" />
                  Lưu truyện vào kho
                </h3>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setSaveStoryDialog({ ...saveStoryDialog, isOpen: false })}
                  className="h-8 w-8"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <Button 
                  onClick={generateStoryMetadata}
                  disabled={saveStoryDialog.isGenerating}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white rounded-none text-[10px] font-mono uppercase h-8"
                >
                  {saveStoryDialog.isGenerating ? (
                    <RefreshCw className="w-3 h-3 animate-spin mr-2" />
                  ) : (
                    <Sparkles className="w-3 h-3 mr-2" />
                  )}
                  Tự động tạo Thể loại & Giới thiệu bằng AI
                </Button>

                <div className="space-y-2">
                  <Label className="text-[10px] font-mono uppercase opacity-60">Tên truyện</Label>
                  <Input 
                    value={saveStoryDialog.name}
                    onChange={(e) => setSaveStoryDialog({ ...saveStoryDialog, name: e.target.value })}
                    className="font-mono text-xs rounded-none border-[#141414]/20"
                    placeholder="Nhập tên truyện..."
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-[10px] font-mono uppercase opacity-60">Thể loại</Label>
                    {saveStoryDialog.isGenerating && <span className="text-[8px] font-mono text-purple-600 animate-pulse">Đang phân tích...</span>}
                  </div>
                  <Input 
                    value={saveStoryDialog.genre}
                    onChange={(e) => setSaveStoryDialog({ ...saveStoryDialog, genre: e.target.value })}
                    className="font-mono text-xs rounded-none border-[#141414]/20"
                    placeholder="Ví dụ: Tiên Hiệp, Huyền Huyễn, Đô Thị..."
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-[10px] font-mono uppercase opacity-60">Giới thiệu truyện</Label>
                    {saveStoryDialog.isGenerating && <span className="text-[8px] font-mono text-purple-600 animate-pulse">Đang viết tóm tắt...</span>}
                  </div>
                  <Textarea 
                    value={saveStoryDialog.description}
                    onChange={(e) => setSaveStoryDialog({ ...saveStoryDialog, description: e.target.value })}
                    className="font-mono text-xs rounded-none border-[#141414]/20 min-h-[100px]"
                    placeholder="Nhập giới thiệu ngắn về nội dung truyện..."
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <Button 
                  onClick={() => setSaveStoryDialog({ ...saveStoryDialog, isOpen: false })}
                  variant="outline"
                  className="flex-1 border-[#141414] text-[#141414] hover:bg-[#141414]/5 rounded-none text-xs font-mono uppercase h-10"
                >
                  Hủy
                </Button>
                <Button 
                  onClick={confirmSaveToLibrary}
                  className="flex-1 bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-xs font-mono uppercase h-10"
                >
                  Xác nhận lưu
                </Button>
              </div>
            </div>
          </motion.div>
        )}

        {exportDialog.isOpen && exportDialog.story && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <div className="bg-white border-2 border-[#141414] p-6 max-w-md w-full space-y-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414]/10 pb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  {exportDialog.type === 'txt' ? <FileText className="w-5 h-5" /> : <FileDown className="w-5 h-5 text-red-600" />}
                  Tải {exportDialog.isConverted ? 'Bản Dịch AI' : 'Bản Gốc'} ({exportDialog.type.toUpperCase()})
                </h3>
                <Button variant="ghost" size="icon" onClick={() => setExportDialog(prev => ({ ...prev, isOpen: false }))} className="h-8 w-8 rounded-none hover:bg-[#141414] hover:text-white">
                  <X className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="space-y-4">
                <p className="text-xs font-mono opacity-70">
                  Truyện: <span className="font-bold">{exportDialog.story.name}</span><br/>
                  Tổng số chương: <span className="font-bold">{exportDialog.chapters.length}</span>
                </p>

                <div className="space-y-4">
                  <div className="border border-[#141414]/20 p-4 space-y-3 bg-[#141414]/5">
                    <Label className="text-xs font-mono uppercase font-bold">Tải tất cả ({exportDialog.chapters.length} chương)</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Button 
                        onClick={() => handleExport('all', 'zip')}
                        className="bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-[10px] font-mono uppercase h-9"
                      >
                        Từng chương (ZIP)
                      </Button>
                      <Button 
                        onClick={() => handleExport('all', 'single')}
                        className="bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-[10px] font-mono uppercase h-9"
                      >
                        Gộp 1 file ({exportDialog.type.toUpperCase()})
                      </Button>
                    </div>
                  </div>
                  
                  <div className="border border-[#141414]/20 p-4 space-y-3 bg-[#141414]/5">
                    <Label className="text-xs font-mono uppercase font-bold">Tải theo khoảng chương</Label>
                    <div className="flex items-center gap-2">
                      <Input 
                        type="number" 
                        min="1" 
                        max={exportDialog.chapters.length}
                        value={exportDialog.startChapter}
                        onChange={(e) => setExportDialog(prev => ({ ...prev, startChapter: e.target.value }))}
                        className="font-mono text-xs rounded-none border-[#141414]/20 h-8"
                      />
                      <span className="font-mono text-xs">đến</span>
                      <Input 
                        type="number" 
                        min="1" 
                        max={exportDialog.chapters.length}
                        value={exportDialog.endChapter}
                        onChange={(e) => setExportDialog(prev => ({ ...prev, endChapter: e.target.value }))}
                        className="font-mono text-xs rounded-none border-[#141414]/20 h-8"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <Button 
                        onClick={() => handleExport('range', 'zip')}
                        variant="outline"
                        className="border-[#141414] text-[#141414] hover:bg-[#141414] hover:text-white rounded-none text-[10px] font-mono uppercase h-8"
                      >
                        Từng chương
                      </Button>
                      <Button 
                        onClick={() => handleExport('range', 'single')}
                        variant="outline"
                        className="border-[#141414] text-[#141414] hover:bg-[#141414] hover:text-white rounded-none text-[10px] font-mono uppercase h-8"
                      >
                        Gộp 1 file
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {pdfDownloadProgress && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <div className="bg-white border-2 border-[#141414] p-8 max-w-md w-full space-y-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center gap-4">
                <div className="bg-red-600 p-3 text-white">
                  <FileDown className="w-6 h-6 animate-bounce" />
                </div>
                <div>
                  <h3 className="text-lg font-mono font-bold uppercase">Đang tạo file PDF...</h3>
                  <p className="text-xs font-mono opacity-60">Vui lòng không đóng trình duyệt</p>
                </div>
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] font-mono uppercase font-bold">
                  <span>Tiến độ</span>
                  <span>{Math.round((pdfDownloadProgress.current / pdfDownloadProgress.total) * 100)}%</span>
                </div>
                <div className="h-4 bg-[#141414]/10 border border-[#141414]/20 overflow-hidden">
                  <motion.div 
                    className="h-full bg-red-600"
                    initial={{ width: 0 }}
                    animate={{ width: `${(pdfDownloadProgress.current / pdfDownloadProgress.total) * 100}%` }}
                  />
                </div>
                <div className="text-center text-[10px] font-mono opacity-40">
                  Đã xử lý {pdfDownloadProgress.current} / {pdfDownloadProgress.total} chương
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {renameChapterDialog.isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
          >
            <div className="bg-white border-2 border-[#141414] p-6 max-w-md w-full shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414]/10 pb-4 mb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  <Edit2 className="w-5 h-5" />
                  Đổi tên chương
                </h3>
                <Button variant="ghost" size="icon" onClick={() => setRenameChapterDialog({ ...renameChapterDialog, isOpen: false })} className="h-8 w-8 rounded-none hover:bg-[#141414] hover:text-white">
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-[10px] font-mono uppercase opacity-50">Tên cũ</Label>
                  <p className="text-xs font-mono bg-[#141414]/5 p-2 border border-[#141414]/10 opacity-60">{renameChapterDialog.oldTitle}</p>
                </div>

                <div className="space-y-2">
                  <Label className="text-[10px] font-mono uppercase opacity-50">Tên mới</Label>
                  <Input 
                    value={renameChapterDialog.newTitle}
                    onChange={(e) => setRenameChapterDialog({ ...renameChapterDialog, newTitle: e.target.value })}
                    placeholder="Nhập tên chương mới..."
                    className="h-10 border-[#141414] rounded-none font-mono text-sm"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <Button 
                    onClick={() => setRenameChapterDialog({ ...renameChapterDialog, isOpen: false })}
                    variant="outline"
                    className="flex-1 border-[#141414] hover:bg-[#141414]/5 rounded-none font-mono uppercase text-xs h-10"
                  >
                    Hủy
                  </Button>
                  <Button 
                    onClick={() => renameChapterDialog.storyId && renameChapter(renameChapterDialog.storyId, renameChapterDialog.chapterIdx, renameChapterDialog.newTitle)}
                    disabled={!renameChapterDialog.newTitle.trim()}
                    className="flex-1 bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-xs font-mono uppercase h-10"
                  >
                    Lưu thay đổi
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {renumberDialog.isOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <div className="bg-white border-2 border-[#141414] p-6 max-w-sm w-full space-y-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414]/10 pb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  <Hash className="w-5 h-5" />
                  Đánh số lại chương
                </h3>
                <Button variant="ghost" size="icon" onClick={() => setRenumberDialog({ ...renumberDialog, isOpen: false })} className="h-8 w-8 rounded-none hover:bg-[#141414] hover:text-white">
                  <X className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="space-y-4">
                <p className="text-[10px] font-mono opacity-60 italic">
                  Hệ thống sẽ chia truyện thành các chương và đánh số lại tiêu đề theo thứ tự thực tế (STT).
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-mono uppercase opacity-60">Tiền tố:</Label>
                    <Input 
                      value={renumberDialog.prefix}
                      onChange={(e) => setRenumberDialog({ ...renumberDialog, prefix: e.target.value })}
                      placeholder="VD: Chương"
                      className="font-mono text-sm h-10 rounded-none border-[#141414]/20 focus:border-[#141414]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-mono uppercase opacity-60">Bắt đầu từ:</Label>
                    <Input 
                      type="number"
                      value={renumberDialog.startNumber}
                      onChange={(e) => setRenumberDialog({ ...renumberDialog, startNumber: parseInt(e.target.value) || 1 })}
                      className="font-mono text-sm h-10 rounded-none border-[#141414]/20 focus:border-[#141414]"
                    />
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <Button 
                    onClick={() => setRenumberDialog({ ...renumberDialog, isOpen: false })}
                    variant="outline"
                    className="flex-1 border-[#141414] hover:bg-[#141414]/5 rounded-none font-mono uppercase text-xs h-10"
                  >
                    Hủy
                  </Button>
                  <Button 
                    onClick={() => renumberDialog.storyId && renumberChapters(renumberDialog.storyId, renumberDialog.startNumber, renumberDialog.prefix)}
                    className="flex-1 bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-xs font-mono uppercase h-10"
                  >
                    Xác nhận
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {editErrorsDialog.isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[120] flex items-center justify-center p-4"
          >
            <div className="bg-white border-2 border-[#141414] p-6 max-w-lg w-full space-y-4 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414]/10 pb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  <Edit2 className="w-5 h-5" />
                  Chỉnh sửa từ điển lỗi
                </h3>
                <Button variant="ghost" size="icon" onClick={() => setEditErrorsDialog(prev => ({ ...prev, isOpen: false }))} className="h-8 w-8 rounded-none hover:bg-[#141414] hover:text-white">
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-[10px] font-mono uppercase opacity-50">Nhập danh sách lỗi (Mỗi dòng một cặp, cách nhau bởi dấu |)</Label>
                  <textarea 
                    value={editErrorsDialog.rawText}
                    onChange={(e) => setEditErrorsDialog(prev => ({ ...prev, rawText: e.target.value }))}
                    placeholder="Ví dụ:&#10;từ sai|từ đúng&#10;loi ocr|lỗi ocr"
                    className="w-full h-[300px] p-3 font-mono text-xs border border-[#141414]/20 rounded-none focus:outline-none focus:border-[#141414] resize-none"
                  />
                </div>
                
                <div className="flex justify-end gap-2">
                  <Button 
                    variant="ghost" 
                    onClick={() => setEditErrorsDialog(prev => ({ ...prev, isOpen: false }))}
                    className="text-[10px] font-mono uppercase rounded-none"
                  >
                    Hủy
                  </Button>
                  <Button 
                    onClick={saveCommonErrors}
                    className="bg-[#141414] text-white hover:bg-[#141414]/90 rounded-none text-[10px] font-mono uppercase px-6"
                  >
                    Lưu danh sách
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {viewChapterDialog.isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#141414]/80 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
          >
            <div className="bg-white border-2 border-[#141414] p-6 max-w-2xl w-full h-[80vh] flex flex-col space-y-4 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex items-center justify-between border-b border-[#141414]/10 pb-4">
                <h3 className="text-lg font-mono font-bold uppercase flex items-center gap-2">
                  <BookOpen className="w-5 h-5" />
                  {viewChapterDialog.title}
                </h3>
                <Button variant="ghost" size="icon" onClick={() => setViewChapterDialog(prev => ({ ...prev, isOpen: false }))} className="h-8 w-8 rounded-none hover:bg-[#141414] hover:text-white">
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="flex-1 overflow-hidden">
                <div className="flex flex-col h-full min-h-0 space-y-2">
                  <Label className="text-[10px] font-mono uppercase opacity-50">Nội dung chương</Label>
                  <div className="flex-1 border border-[#141414]/10 p-4 bg-white font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto custom-scrollbar">
                    {viewChapterDialog.content}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
