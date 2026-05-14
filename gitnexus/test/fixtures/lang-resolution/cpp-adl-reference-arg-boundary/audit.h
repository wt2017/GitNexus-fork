#pragma once

namespace audit {
  struct Event {};
  void record(Event& e);
  void note(int& n);
}
