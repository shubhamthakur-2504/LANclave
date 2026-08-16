import { Tabs } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { C } from "@/constants/colors";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: C.accent,
        tabBarInactiveTintColor: C.textMuted,
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "My Sandbox",
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 18, color }}>📦</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="peers"
        options={{
          title: "Paired Peers",
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 18, color }}>🤝</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan & Pair",
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 18, color }}>📡</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="transfers"
        options={{
          title: "Transfers",
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 18, color }}>🔄</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 18, color }}>⚙️</Text>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: C.surface,
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
