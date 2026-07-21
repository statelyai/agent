import type { ComponentProps } from "react";
import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return <Group className={cn("resizable-group", className)} {...props} />;
}

export const ResizablePanel = Panel;

export function ResizableHandle({ className, ...props }: ComponentProps<typeof Separator>) {
  return (
    <Separator className={cn("resizable-handle", className)} {...props}>
      <span className="resizable-handle__grip" aria-hidden="true">
        <GripVertical size={12} strokeWidth={1.8} />
      </span>
    </Separator>
  );
}
