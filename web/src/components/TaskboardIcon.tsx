import type { ImgHTMLAttributes } from "react";
import aiLauncher from "../assets/figma-taskboard/ai-launcher.svg";
import automationPause from "../assets/figma-taskboard/automation-pause.svg";
import automationPlay from "../assets/figma-taskboard/automation-play.svg";
import breadcrumb from "../assets/figma-taskboard/breadcrumb.svg";
import calendar from "../assets/figma-taskboard/calendar.svg";
import columnAdd from "../assets/figma-taskboard/column-add.svg";
import conversation from "../assets/figma-taskboard/conversation.svg";
import create from "../assets/figma-taskboard/create.svg";
import dropdown from "../assets/figma-taskboard/dropdown.svg";
import filter from "../assets/figma-taskboard/filter.svg";
import home from "../assets/figma-taskboard/home.svg";
import panel from "../assets/figma-taskboard/panel.svg";
import search from "../assets/figma-taskboard/search.svg";
import sidebarAdd from "../assets/figma-taskboard/sidebar-add.svg";
import statusBlocked from "../assets/figma-taskboard/status-blocked.svg";
import statusProgress from "../assets/figma-taskboard/status-progress.svg";
import statusReview from "../assets/figma-taskboard/status-review.svg";
import statusTodo from "../assets/figma-taskboard/status-todo.svg";

const TASKBOARD_ICONS = {
  aiLauncher,
  automationPause,
  automationPlay,
  breadcrumb,
  calendar,
  columnAdd,
  conversation,
  create,
  dropdown,
  filter,
  home,
  panel,
  search,
  sidebarAdd,
  statusBlocked,
  statusProgress,
  statusReview,
  statusTodo,
} as const;

export type TaskboardIconName = keyof typeof TASKBOARD_ICONS;

interface TaskboardIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> {
  name: TaskboardIconName;
}

export function TaskboardIcon({ name, className, ...props }: TaskboardIconProps) {
  return (
    <img
      {...props}
      className={`taskboard-icon${className ? ` ${className}` : ""}`}
      src={TASKBOARD_ICONS[name]}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
