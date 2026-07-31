import type { Task, TaskStatus } from "../types";
import { TASK_STATUSES } from "../types";
import {
  SECONDARY_STATUSES,
  type SecondaryTaskStatus,
} from "../issueBoardStatuses";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";

interface OtherTasksPanelProps {
  activeStatus: SecondaryTaskStatus;
  tasksByStatus: Record<TaskStatus, Task[]>;
  hasActiveFilters: boolean;
  draggedTaskId: string | null;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  onStatusChange: (status: SecondaryTaskStatus) => void;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
}

export function OtherTasksPanel({
  activeStatus,
  tasksByStatus,
  hasActiveFilters,
  draggedTaskId,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  onStatusChange,
  onClose,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
}: OtherTasksPanelProps) {
  const tasks = tasksByStatus[activeStatus];

  return (
    <aside
      className="other-tasks-panel"
      id="other-tasks-panel"
      aria-labelledby="other-tasks-heading"
    >
      <header className="other-tasks-header">
        <div className="other-tasks-heading">
          <LinearIcon name="panel" />
          <h2 id="other-tasks-heading">其他任务</h2>
        </div>
        <button
          className="icon-button other-tasks-close"
          type="button"
          aria-label="关闭其他任务"
          title="关闭其他任务"
          onClick={onClose}
        >
          <LinearIcon name="close" />
        </button>
      </header>

      <div className="other-tasks-tabs" role="tablist" aria-label="其他任务状态">
        {SECONDARY_STATUSES.map((status) => {
          const details = STATUS_DETAILS[status];
          const selected = status === activeStatus;
          return (
            <button
              className={`other-tasks-tab${selected ? " is-active" : ""}`}
              id={`other-tasks-tab-${status}`}
              key={status}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="other-tasks-list"
              title={`${details.label} ${tasksByStatus[status].length}`}
              onClick={() => onStatusChange(status)}
            >
              <span className="other-tasks-tab-label">{details.label}</span>
              <span className="other-tasks-tab-count" aria-label={`${tasksByStatus[status].length} 个议题`}>
                {tasksByStatus[status].length}
              </span>
            </button>
          );
        })}
      </div>

      <div
        className="other-tasks-list"
        id="other-tasks-list"
        role="tabpanel"
        aria-labelledby={`other-tasks-tab-${activeStatus}`}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            statusIndex={TASK_STATUSES.indexOf(task.status)}
            isDragging={draggedTaskId === task.id}
            dragShift={0}
            isMoving={movingTaskId === task.id}
            isSettling={settlingTaskId === task.id}
            isContextMenuOpen={contextMenuTaskId === task.id}
            onEdit={onEdit}
            onContextMenu={onContextMenu}
            onMove={onMove}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onOpenThread={onOpenThread}
          />
        ))}
        {tasks.length === 0 && (
          <div className="other-tasks-empty">
            <LinearIcon name={hasActiveFilters ? "search" : "panel"} />
            <strong>{hasActiveFilters ? "当前筛选下无匹配议题" : "暂无议题"}</strong>
            <span>{hasActiveFilters ? "搜索和筛选会同步作用于所有状态。" : `没有${STATUS_DETAILS[activeStatus].label}。`}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
