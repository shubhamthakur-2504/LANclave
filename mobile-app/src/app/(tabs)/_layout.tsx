import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { C } from "@/constants/colors";
import { Icon } from "@/components/Icon";
import { useTransfers } from "@/contexts/TransferContext";

export default function TabsLayout() {
  // A badge on the Transfers tab, so movement is visible from every screen
  // rather than only from the tab itself (U2.2).
  const { transfers } = useTransfers();
  const activeCount = transfers.filter(
    (t) => t.status === "in_progress" || t.status === "pending",
  ).length;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: C.action,
        tabBarInactiveTintColor: C.contentFaint,
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "My Sandbox",
          tabBarIcon: ({ color }) => (
            <Icon name="sandbox" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="peers"
        options={{
          title: "Paired Peers",
          tabBarIcon: ({ color }) => (
            <Icon name="peers" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan & Pair",
          tabBarIcon: ({ color }) => (
            <Icon name="scan" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="transfers"
        options={{
          title: "Transfers",
          tabBarBadge: activeCount > 0 ? activeCount : undefined,
          tabBarBadgeStyle: styles.badge,
          tabBarIcon: ({ color }) => (
            <Icon name="transfers" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => (
            <Icon name="settings" size={22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: C.action,
    color: C.onAction,
    fontSize: 10,
    fontWeight: "700",
  },
  tabBar: {
    backgroundColor: C.surfaceRaised,
    borderTopColor: C.border,
    borderTopWidth: 1,
    height: 60,
    paddingBottom: 8,
    paddingTop: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
  },
});
