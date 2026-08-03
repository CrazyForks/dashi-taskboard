import type { Task, TaskStatus } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import {
  SECONDARY_STATUSES,
  type SecondaryTaskStatus,
} from "../issueBoardStatuses";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";
import { TaskboardIcon } from "./TaskboardIcon";

interface OtherTasksPanelProps {
  activeStatus: SecondaryTaskStatus;
  tasksByStatus: Record<TaskStatus, Task[]>;
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  hasActiveFilters: boolean;
  draggedTaskId: string | null;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  onStatusChange: (status: SecondaryTaskStatus) => void;
  onCreate: (status: SecondaryTaskStatus) => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

export function OtherTasksPanel({
  activeStatus,
  tasksByStatus,
  presentations,
  now,
  hasActiveFilters,
  draggedTaskId,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  onStatusChange,
  onCreate,
  onEdit,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onOpenConversation,
}: OtherTasksPanelProps) {
  const tasks = tasksByStatus[activeStatus];

  return (
    <aside
      className="other-tasks-panel"
      id="other-tasks-panel"
      aria-label="其他任务"
    >
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

      <button
        className="other-tasks-add"
        type="button"
        aria-label={`在${STATUS_DETAILS[activeStatus].label}中新建议题`}
        title={`添加到${STATUS_DETAILS[activeStatus].label}`}
        onClick={() => onCreate(activeStatus)}
      >
        <TaskboardIcon name="sidebarAdd" />
      </button>

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
            variant="sidebar"
            presentation={presentations[task.id]}
            now={now}
            isDragging={draggedTaskId === task.id}
            dragShift={0}
            isMoving={movingTaskId === task.id}
            isSettling={settlingTaskId === task.id}
            isContextMenuOpen={contextMenuTaskId === task.id}
            onEdit={onEdit}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onOpenConversation={onOpenConversation}
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
