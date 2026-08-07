import { useState } from "react";
import { attachmentContentUrl } from "../api";
import type { ActorIdentity, Task, TaskPriority } from "../types";
import { labelPresentation } from "../labels";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { LinearPriorityIcon } from "./LinearIcon";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskboardIcon } from "./TaskboardIcon";
import completeIcon from "../assets/figma-taskboard/card-complete.svg";
import processingAnimation from "../assets/figma-taskboard/loading-16.svg";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

interface TaskCardProps {
  task: Task;
  variant?: "main" | "sidebar";
  presentation: TaskCardPresentation;
  now: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  onEdit: (task: Task) => void;
  onComplete?: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

function calendarDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function createdDate(value: string) {
  return `${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" })
    .format(new Date(value))}创建`;
}

function elapsedTime(startedAt: string | null, now: number) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m${elapsed % 60 ? `${elapsed % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function firstTaskImage(task: Task) {
  const markdownImage = task.description.match(
    /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\)/,
  );
  return markdownImage?.[1]
    ?? markdownImage?.[2]
    ?? (task.previewImage ? attachmentContentUrl(task.previewImage) : null);
}

function TaskCardMedia({ src }: { src: string }) {
  const [clamped, setClamped] = useState(false);

  return (
    <div className={`task-card-media${clamped ? " is-clamped" : ""}`}>
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          setClamped(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight < 3 / 4);
        }}
      />
    </div>
  );
}

function ProcessingProgress({
  presentation,
}: {
  presentation: TaskCardPresentation;
}) {
  const { processing } = presentation;
  const hasProgress = processing.total !== null
    && processing.total > 0
    && processing.completed !== null;
  if (!hasProgress) return null;

  const total = processing.total!;
  const completed = Math.max(0, Math.min(processing.completed!, total));
  const label = `处理进度 ${completed}/${total}`;

  return (
    <div className="card-progress-row">
      <div
        className={`task-progress-segments${processing.running ? " is-running" : ""}`}
        aria-label={label}
        title={label}
      >
        {Array.from({ length: total }, (_, index) => (
          <span className={index < completed ? "is-complete" : ""} key={index} />
        ))}
      </div>
    </div>
  );
}

function ProcessingStatusRow({
  presentation,
  now,
  onOpenConversation,
}: {
  presentation: TaskCardPresentation;
  now: number;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}) {
  const elapsed = elapsedTime(presentation.processing.startedAt, now);
  const running = presentation.processing.running;
  return (
    <div className={`task-processing-row${running ? " is-running" : " is-paused"}`}>
      {running && <img className="task-processing-glyph" src={processingAnimation} alt="" aria-hidden="true" />}
      <span className="task-processing-label">
        {running ? (elapsed ? `已处理 ${elapsed}...` : "正在处理...") : "暂停处理"}
      </span>
      <span className="task-processing-spacer" aria-hidden="true" />
      {presentation.conversations.length > 0 && (
        <TaskConversationMenu
          conversations={presentation.conversations}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

function ParticipantAvatars({ participants }: { participants: ActorIdentity[] }) {
  if (participants.length === 0) return null;
  return (
    <span
      className="task-participants"
      aria-label={`参与人：${participants.map((participant) => participant.name).join("、")}`}
    >
      {participants.map((participant) => (
        <ActorAvatar
          actor={participant}
          className="task-participant-avatar"
          key={`${participant.type}:${participant.id}`}
        />
      ))}
    </span>
  );
}

function LabelsAndDueDate({ task }: { task: Task }) {
  const dueDate = task.dueDate ? calendarDate(task.dueDate) : null;
  return (
    <>
      {task.labels.slice(0, 2).map((label) => {
        const presentation = labelPresentation(label);
        return (
          <span className={`label-chip${presentation.tone ? ` label-chip-${presentation.tone}` : ""}`} key={label}>
            {presentation.tone && <i aria-hidden="true" />}
            <span>{presentation.name}</span>
          </span>
        );
      })}
      {task.labels.length > 2 && (
        <span className="label-more" title={task.labels.slice(2).map((label) => labelPresentation(label).name).join(", ")}>
          +{task.labels.length - 2}
        </span>
      )}
      {dueDate && (
        <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
          <TaskboardIcon name="calendar" /> {dueDate}
        </span>
      )}
    </>
  );
}

function PriorityChip({ task }: { task: Task }) {
  return (
    <span className={`priority-chip priority-chip-${task.priority}`} title={`优先级：${PRIORITY_LABELS[task.priority]}`}>
      <LinearPriorityIcon priority={task.priority} />
      <span>{PRIORITY_LABELS[task.priority]}</span>
    </span>
  );
}

export function TaskCard({
  task,
  variant = "main",
  presentation,
  now,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  onEdit,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onOpenConversation,
}: TaskCardProps) {
  const creator: ActorIdentity = {
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  };
  const processingCard = task.status === "in_progress";
  const supportsConversation = task.status === "in_progress"
    || task.status === "in_review"
    || task.status === "blocked"
    || task.status === "done"
    || task.status === "canceled";
  const showsConversation = supportsConversation && presentation.conversations.length > 0;
  const showsInlineParticipants = variant === "main"
    && task.participants.length > 0;
  const image = firstTaskImage(task);
  const hasProperties = task.priority !== "none" || task.labels.length > 0 || task.dueDate;
  const showsProperties = !processingCard
    && (hasProperties || showsInlineParticipants || showsConversation);

  return (
    <article
      className={`task-card task-card-${variant} status-${task.status}${processingCard ? " is-processing-card" : ""}${processingCard && presentation.processing.running ? " is-running-card" : ""}${image ? " has-media" : ""}${presentation.unread ? " is-unread" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">ID: {task.identifier}</span>
        </span>
        {presentation.unread && <span className="task-unread-dot" aria-label="有未读更新" />}
        {task.status === "in_review" && onComplete && (
          <button
            className="task-card-complete"
            type="button"
            aria-label={`完成 ${task.identifier}`}
            title="完成"
            onClick={(event) => {
              event.stopPropagation();
              onComplete(task);
            }}
          >
            <img src={completeIcon} alt="" aria-hidden="true" />
            <span>完成</span>
          </button>
        )}
        {variant === "sidebar" && (
          <span className="sidebar-card-creator">
            <ParticipantAvatars participants={task.participants.length ? task.participants : [creator]} />
            <span>{createdDate(task.createdAt)}</span>
          </span>
        )}
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {image && (
        <TaskCardMedia key={image} src={image} />
      )}

      {showsProperties && (
        <div className="card-properties" aria-label="议题属性">
          {task.priority !== "none" && <PriorityChip task={task} />}
          <LabelsAndDueDate task={task} />
          {showsInlineParticipants && <ParticipantAvatars participants={task.participants} />}
          {showsConversation && <span className="card-properties-spacer" aria-hidden="true" />}
          {showsConversation && (
            <TaskConversationMenu
              conversations={presentation.conversations}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      )}

      {processingCard && (
        <>
          <ProcessingProgress presentation={presentation} />
          <ProcessingStatusRow
            presentation={presentation}
            now={now}
            onOpenConversation={onOpenConversation}
          />
        </>
      )}
    </article>
  );
}
