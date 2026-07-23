import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { IconChevronDown, IconMessageCircle, IconSend2 } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { Slider } from "@/ui-lib/base-components/slider/slider";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import type { KbSearchMode } from "@/api/kb-search.types";

import type { PlaygroundChatEntry, PlaygroundQueryFileType, PlaygroundQuerySettings } from "./kb-detail-playground.types";
import "./playground-chat-column.scss";

// -- Props --

type PlaygroundChatColumnProps = {
  chatHistory: PlaygroundChatEntry[];
  activeQueryIndex: number | null;
  isLoading: boolean;
  querySettings: PlaygroundQuerySettings;
  onQuerySettingsChange: (settings: PlaygroundQuerySettings) => void;
  onSelectQuery: (index: number) => void;
  onSendQuery: (query: string) => void;
};

const SEARCH_MODE_ITEMS: { key: KbSearchMode; value: KbSearchMode; label: string }[] = [
  { key: "vector", value: "vector", label: "Vector" },
  { key: "fts", value: "fts", label: "Full-text(FTS)" },
  { key: "hybrid", value: "hybrid", label: "Hybrid(Vector + FTS)" },
];

const FILE_TYPE_ITEMS: { key: PlaygroundQueryFileType; value: PlaygroundQueryFileType; label: string }[] = [
  { key: "pdf", value: "pdf", label: "pdf" },
  { key: "docx", value: "docx", label: "docx" },
  { key: "txt", value: "txt", label: "txt" },
];

// -- Component --

function PlaygroundChatColumn({
  chatHistory,
  activeQueryIndex,
  isLoading,
  querySettings,
  onQuerySettingsChange,
  onSelectQuery,
  onSendQuery,
}: PlaygroundChatColumnProps): ReactElement {
  const [inputValue, setInputValue] = useState("");
  const [isQuerySettingsOpen, setIsQuerySettingsOpen] = useState(false);
  const [draftQuerySettings, setDraftQuerySettings] = useState<PlaygroundQuerySettings>(querySettings);
  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = inputValue.trim().length > 0 && !isLoading;

  // auto-scroll to bottom when new entries arrive
  useEffect(() => {
    /* v8 ignore start -- defensive guard: ref is always attached after mount in DOM */
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    /* v8 ignore stop */
  }, [chatHistory.length]);

  // auto-resize textarea
  const resizeTextarea = useCallback(() => {
    /* v8 ignore start -- defensive guard: ref is always attached after mount in DOM */
    const ta = textareaRef.current;
    if (!ta) return;
    /* v8 ignore stop */
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading) return;
    onSendQuery(trimmed);
    setInputValue("");
    // reset textarea height after clearing
    requestAnimationFrame(() => {
      /* v8 ignore start -- defensive guard: ref is always attached after mount in DOM */
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = "auto";
      }
      /* v8 ignore stop */
    });
  }, [inputValue, isLoading, onSendQuery]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleBubbleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, index: number) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelectQuery(index);
      }
    },
    [onSelectQuery],
  );

  const openQuerySettings = useCallback(() => {
    setDraftQuerySettings(querySettings);
    setIsQuerySettingsOpen(true);
  }, [querySettings]);

  const handleCancelQuerySettings = useCallback(() => {
    setIsQuerySettingsOpen(false);
  }, []);

  const handleSaveQuerySettings = useCallback(() => {
    onQuerySettingsChange(draftQuerySettings);
    setIsQuerySettingsOpen(false);
  }, [draftQuerySettings, onQuerySettingsChange]);

  const isHybridSearchMode = draftQuerySettings.searchMode === "hybrid";

  return (
    <Card className="kb-playground__column kb-playground__column--chat playground-chat">
      <CardHeader
        icon={<IconMessageCircle size={20} />}
        title="Chat"
        hasSeparator
      />

      <div ref={bodyRef} className="kb-playground__column-body playground-chat__body">
        {chatHistory.map((entry, index) => (
          <div
            key={entry.id}
            role="button"
            tabIndex={0}
            className={`playground-chat__bubble ${activeQueryIndex === index ? "playground-chat__bubble--active" : ""}`}
            onClick={() => onSelectQuery(index)}
            onKeyDown={(e) => handleBubbleKeyDown(e, index)}
            aria-pressed={activeQueryIndex === index}
          >
            <Typography Component="p" fontSize="fs14">
              {entry.query}
            </Typography>
          </div>
        ))}

        {chatHistory.length === 0 && (
          <div className="playground-chat__empty">
            <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
              Ask a question to test your knowledge base
            </Typography>
          </div>
        )}
      </div>

      <div className="playground-chat__footer">
        <div className="playground-chat__input-wrapper">
          <textarea
            ref={textareaRef}
            className="playground-chat__textarea"
            placeholder="Type your question here..."
            value={inputValue}
            rows={1}
            onChange={(e) => {
              setInputValue(e.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <div className="playground-chat__input-controls">
            <button
              type="button"
              className="playground-chat__query-settings-trigger"
              onClick={openQuerySettings}
              aria-haspopup="dialog"
            >
              Query settings
              <IconChevronDown size={14} aria-hidden />
            </button>
            <div className="playground-chat__send-btn">
              <Button
                variant="icon"
                size="medium"
                icon={<IconSend2 size={20} />}
                aria-label="Send"
                onClick={handleSend}
                isDisabled={!canSend}
                loading={isLoading}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={isQuerySettingsOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleCancelQuerySettings();
          }
        }}
        size="lg"
      >
        <DialogPopup showCloseButton={false} className="playground-chat__query-settings-dialog">
          {isQuerySettingsOpen && (
            <Card>
              <CardHeader title="Query settings" hasSeparator />
              <CardContent>
                <CardBlock type="description">
                  <div className="playground-chat__query-settings-content">
                    <section className="playground-chat__query-settings-section">
                      <Typography Component="h3" fontSize="fs14" boldness="semibold">
                        Retrieval configuration
                      </Typography>
                      <Slider
                        label="Top K results"
                        min={1}
                        max={100}
                        value={draftQuerySettings.topK}
                        isShowLimits
                        isShowCurrent
                        isEditInput
                        onValueChange={(value) => {
                          const nextValue = Array.isArray(value) ? value[0] : value;
                          setDraftQuerySettings((prev) => ({ ...prev, topK: nextValue }));
                        }}
                      />
                      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                        Determines how broad the search is. Higher values include more context, but the answer may be less focused.
                      </Typography>
                      <SelectDropdown
                        label="Search mode"
                        items={SEARCH_MODE_ITEMS}
                        value={draftQuerySettings.searchMode}
                        onValueChange={(value) => {
                          const nextValue = Array.isArray(value) ? value[0] : value;
                          if (nextValue) {
                            setDraftQuerySettings((prev) => ({
                              ...prev,
                              searchMode: nextValue as KbSearchMode,
                            }));
                          }
                        }}
                        options={{
                          isSearchable: false,
                        }}
                      />
                    </section>

                    <section className="playground-chat__query-settings-section">
                      <Typography Component="h3" fontSize="fs14" boldness="semibold">
                        Reranking configuration
                      </Typography>
                      <div className="playground-chat__query-settings-checkbox-row">
                        <Checkbox
                          checked={draftQuerySettings.useReranking}
                          onCheckedChange={(checked) => {
                            setDraftQuerySettings((prev) => ({ ...prev, useReranking: checked }));
                          }}
                          isDisabled={!isHybridSearchMode}
                          ariaLabel="Enable reranking"
                        />
                        <Typography Component="span" fontSize="fs14">
                          Enable reranking
                        </Typography>
                      </div>
                      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                        {isHybridSearchMode
                          ? "Improve hybrid search relevance by merging vector and full-text results with reciprocal rank fusion (RRF)."
                          : "Reranking is available when search mode is Hybrid (Vector + FTS)."}
                      </Typography>
                    </section>

                    <section className="playground-chat__query-settings-section" hidden>
                      <Typography Component="h3" fontSize="fs14" boldness="semibold">
                        File scope
                      </Typography>
                      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                        Create a file scope to define which files are included in your dataset.
                      </Typography>
                      <SelectDropdown
                        label="File type"
                        items={FILE_TYPE_ITEMS}
                        value={draftQuerySettings.fileTypes}
                        onValueChange={(value) => {
                          const nextValue = Array.isArray(value) ? value : [];
                          setDraftQuerySettings((prev) => ({
                            ...prev,
                            fileTypes: nextValue as PlaygroundQueryFileType[],
                          }));
                        }}
                        options={{
                          isMultiSelect: true,
                          isChipDisplay: true,
                          cellHasCheckbox: true,
                          isSearchable: false,
                        }}
                        placeholder="Select file types"
                      />
                    </section>
                  </div>
                </CardBlock>
              </CardContent>
              <CardFooter
                hasSeparator
                alignment="end"
                actions={[
                  { variant: "solid", size: "medium", label: "Save", onClick: handleSaveQuerySettings },
                  { variant: "outline", size: "medium", label: "Cancel", onClick: handleCancelQuerySettings },
                ]}
              />
            </Card>
          )}
        </DialogPopup>
      </Dialog>
    </Card>
  );
}

export { PlaygroundChatColumn };
export type { PlaygroundChatColumnProps };
