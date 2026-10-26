import * as Router from "react-router";
import * as TRPC from "@trpc/react-query";
import * as TRPCClient from "@trpc/client";
import * as Query from "@tanstack/react-query";
import * as SuperJSON from "superjson";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Slot from "@radix-ui/react-slot";
import * as Label from "@radix-ui/react-label";
import * as Slider from "@radix-ui/react-slider";
import * as CVA from "class-variance-authority";
import * as CLSX from "clsx";
import * as Merge from "tailwind-merge";

// Router state belongs to this disposable work, never to Cloudig's page URL.
export const projectModules = [
  ["react-router", { ...Router, BrowserRouter: Router.MemoryRouter }],
  ["@trpc/react-query", TRPC], ["@trpc/client", TRPCClient], ["@tanstack/react-query", Query], ["superjson", SuperJSON],
  ["@radix-ui/react-alert-dialog", AlertDialog], ["@radix-ui/react-slot", Slot], ["@radix-ui/react-label", Label], ["@radix-ui/react-slider", Slider],
  ["class-variance-authority", CVA], ["clsx", CLSX], ["tailwind-merge", Merge]
];
