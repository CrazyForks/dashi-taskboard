import type { CSSProperties } from "react";
import type { ActorIdentity, Task } from "../types";
import { labelPresentation } from "../labels";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskboardIcon } from "./TaskboardIcon";

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

function ProcessingStatus({
  presentation,
  now,
}: {
  presentation: TaskCardPresentation;
  now: number;
}) {
  const { processing } = presentation;
  const hasTodo = processing.running
    && processing.total !== null
    && processing.total > 0
    && processing.completed !== null;
  const percent = hasTodo
    ? Math.max(0, Math.min(100, Math.round((processing.completed! / processing.total!) * 100)))
    : 0;
  const elapsed = elapsedTime(processing.startedAt, now);
  const label = processing.running
    ? `正在处理${elapsed ? ` · ${elapsed}` : ""}…`
    : "暂停处理";
  const style = hasTodo
    ? { "--task-progress": `${percent}%` } as CSSProperties
    : undefined;

  return (
    <div className={`task-processing${processing.running ? " is-running" : " is-paused"}`}>
      <span className="task-processing-ring" style={style} aria-hidden="true">
        {hasTodo && <span>{percent}</span>}
      </span>
      <span className="task-processing-label">{label}</span>
    </div>
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
  const processingCard = variant === "main" && task.status === "in_progress";
  const showsConversation = ["in_progress", "in_review", "done", "canceled"].includes(task.status);

  return (
    <article
      className={`task-card task-card-${variant} status-${task.status}${processingCard ? " is-processing-card" : ""}${presentation.unread ? " is-unread" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
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
          <span className="task-identifier">{task.identifier}</span>
        </span>
        {presentation.unread && <span className="task-unread-dot" aria-label="有未读更新" />}
        {variant === "sidebar" && (
          <span className="sidebar-card-creator">
            <ActorAvatar actor={creator} className="card-creator-avatar" />
            <span>{createdDate(task.createdAt)}</span>
          </span>
        )}
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {processingCard ? (
        <div className="card-processing-row">
          <ProcessingStatus presentation={presentation} now={now} />
          {showsConversation && (
            <TaskConversationMenu
              conversations={presentation.conversations}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      ) : (
        <div className="card-properties" aria-label="议题属性">
          <LabelsAndDueDate task={task} />
          {showsConversation && (
            <TaskConversationMenu
              conversations={presentation.conversations}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      )}
    </article>
  );
}
