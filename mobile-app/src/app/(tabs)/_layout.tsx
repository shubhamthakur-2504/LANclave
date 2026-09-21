import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { C } from "@/constants/colors";
import { Icon } from "@/components/Icon";

export default function TabsLayout() {
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
